package ai.edgez.react_native_sdk;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConfiguration;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.util.Log;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Userspace USB/IP server backed by Android's public USB Host APIs.
 *
 * <p>The server accepts USB/IP frames on an Android abstract Unix socket.
 * The native libp2p tap proxy routes remote target port 3240 directly to that
 * socket, so Android does not expose a TCP/IP listener.</p>
 */
final class UsbIpServer implements AutoCloseable {
    static final int ROUTE_PORT = 3240;
    private static final AtomicInteger SOCKET_SEQUENCE = new AtomicInteger();
    private static final String TAG = "EdgezReactNativeSdk";
    static final String ACTION_USB_PERMISSION =
            "ai.edgez.react_native_sdk.USB_IP_PERMISSION";

    private static final int USBIP_VERSION = 0x0111;
    private static final int OP_REQ_IMPORT = 0x8003;
    private static final int OP_REP_IMPORT = 0x0003;
    private static final int OP_REQ_DEVLIST = 0x8005;
    private static final int OP_REP_DEVLIST = 0x0005;
    private static final int USBIP_CMD_SUBMIT = 0x0001;
    private static final int USBIP_CMD_UNLINK = 0x0002;
    private static final int USBIP_RET_SUBMIT = 0x0003;
    private static final int USBIP_RET_UNLINK = 0x0004;
    private static final int ST_OK = 0;
    private static final int ST_NA = 1;
    private static final int USBIP_DIR_OUT = 0;
    private static final int USBIP_DIR_IN = 1;
    private static final int EIO = -5;
    private static final int ECONNRESET = -104;
    private static final int MAX_TRANSFER = 4 * 1024 * 1024;
    private static final int CONTROL_TRANSFER_TIMEOUT_MS = 1000;
    private static final int BULK_OUT_TIMEOUT_MS = 1000;
    private static final int ESP_FAST_BULK_OUT_BYTES = 512 * 1024;
    // Android's synchronous bulkTransfer cannot be interrupted while it is
    // blocked. USB/IP UNLINK only interrupts the worker thread, so a long
    // timeout leaves a cancelled serial read at the head of the endpoint FIFO
    // and delays esptool's next ROM-sync read. Poll IN endpoints quickly so a
    // cancellation is observed inside the bootloader reset/sync window.
    private static final int BULK_IN_POLL_TIMEOUT_MS = 50;
    private static final int SEGGER_VENDOR_ID = 0x1366;
    private static final int CP210X_VENDOR_ID = 0x10c4;
    private static final int CP210X_REQUEST_TYPE = 0x41;
    private static final int CP210X_SET_MHS = 0x07;
    private static final int JLINK_TRACE_LIMIT = 200;

    interface EventListener {
        void onUsbEvent(String event);
    }

    private final Context context;
    private final UsbManager usbManager;
    private final EventListener eventListener;
    private final String socketName;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private final Set<LocalSocket> sockets = ConcurrentHashMap.newKeySet();
    private final Set<DeviceSession> deviceSessions = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean running = new AtomicBoolean();
    private final AtomicBoolean receiverRegistered = new AtomicBoolean();
    private volatile LocalServerSocket listener;

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context receiverContext, Intent intent) {
            String action = intent.getAction();
            UsbDevice device = usbDeviceExtra(intent);
            if (ACTION_USB_PERMISSION.equals(action)) {
                boolean granted = intent.getBooleanExtra(
                        UsbManager.EXTRA_PERMISSION_GRANTED, false);
                Log.i(TAG, "USB/IP permission device=" + deviceLabel(device)
                        + " granted=" + granted);
                notifyUsbEvent(granted ? "available" : "permission_denied", device);
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                Log.i(TAG, "USB/IP device attached: " + deviceLabel(device));
                notifyUsbEvent("attached", device);
                requestPermission(device);
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                Log.i(TAG, "USB/IP device detached: " + deviceLabel(device));
                notifyUsbEvent("detached", device);
                closeSessions(device);
            }
        }
    };

    UsbIpServer(Context context, EventListener eventListener) {
        this.context = context.getApplicationContext();
        this.eventListener = eventListener;
        usbManager = this.context.getSystemService(UsbManager.class);
        socketName = "edgez-usbip-" + android.os.Process.myPid()
                + "-" + SOCKET_SEQUENCE.incrementAndGet();
    }

    void start() throws IOException {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        LocalServerSocket newListener = null;
        try {
            // Bind before registering callbacks so a failed bind cannot leak a
            // receiver or a half-started executor into the next proxy run.
            newListener = new LocalServerSocket(socketName);
            listener = newListener;

            IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
            filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
            filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                context.registerReceiver(usbReceiver, filter);
            }
            receiverRegistered.set(true);
            for (UsbDevice device : usbManager.getDeviceList().values()) {
                requestPermission(device);
            }

            clients.execute(this::acceptLoop);
            Log.i(TAG, "USB/IP server listening on abstract socket @" + socketName);
        } catch (IOException | RuntimeException exception) {
            running.set(false);
            listener = null;
            if (receiverRegistered.compareAndSet(true, false)) {
                try {
                    context.unregisterReceiver(usbReceiver);
                } catch (IllegalArgumentException ignored) {
                }
            }
            if (newListener != null) {
                try {
                    newListener.close();
                } catch (IOException ignored) {
                }
            }
            clients.shutdownNow();
            throw exception;
        }
    }

    List<String> exportedDevices() {
        List<String> devices = new ArrayList<>();
        for (UsbDevice device : usbManager.getDeviceList().values()) {
            if (usbManager.hasPermission(device)) {
                devices.add(busId(device) + "=" + deviceLabel(device));
            }
        }
        return devices;
    }

    String socketName() {
        return socketName;
    }

    private void acceptLoop() {
        LocalServerSocket server = listener;
        while (running.get() && server != null) {
            try {
                LocalSocket socket = server.accept();
                sockets.add(socket);
                clients.execute(() -> handleClient(socket));
            } catch (IOException exception) {
                if (running.get()) {
                    Log.w(TAG, "USB/IP accept failed", exception);
                }
            }
        }
    }

    void publishUsbSnapshot() {
        notifyUsbEvent("snapshot_begin", null);
        for (UsbDevice device : usbManager.getDeviceList().values()) {
            if (usbManager.hasPermission(device)) {
                notifyUsbEvent("present", device);
            }
        }
        notifyUsbEvent("snapshot_end", null);
    }

    void executeDeviceControl(String requestedBusId, String action) throws IOException {
        for (DeviceSession session : deviceSessions) {
            if (session.sessionBusId.equals(requestedBusId)) {
                session.executeDeviceControl(action);
                return;
            }
        }
        throw new IOException("USB device " + requestedBusId + " is not imported");
    }

    private void notifyUsbEvent(String action, UsbDevice device) {
        String bus = device == null ? "-" : busId(device);
        int vendorId = device == null ? 0 : device.getVendorId();
        int productId = device == null ? 0 : device.getProductId();
        eventListener.onUsbEvent("1 " + action + " " + bus + " "
                + String.format("%04x %04x", vendorId, productId));
    }

    private void handleClient(LocalSocket socket) {
        try (DataInputStream input = new DataInputStream(socket.getInputStream());
             DataOutputStream output = new DataOutputStream(socket.getOutputStream())) {
            while (running.get()) {
                int version;
                try {
                    version = input.readUnsignedShort();
                } catch (EOFException eof) {
                    return;
                }
                int opcode = input.readUnsignedShort();
                input.readInt(); // request status is reserved
                if (version < 0x0106 || version > USBIP_VERSION) {
                    throw new IOException("unsupported USB/IP version 0x"
                            + Integer.toHexString(version));
                }
                if (opcode == OP_REQ_DEVLIST) {
                    writeDeviceList(output, version);
                } else if (opcode == OP_REQ_IMPORT) {
                    byte[] rawBusId = new byte[32];
                    input.readFully(rawBusId);
                    String requestedBusId = cString(rawBusId);
                    UsbDevice device = findDevice(requestedBusId);
                    if (device == null || !usbManager.hasPermission(device)) {
                        Log.w(TAG, "USB/IP import unavailable: busid=" + requestedBusId
                                + " found=" + (device != null)
                                + " permission=" + (device != null
                                && usbManager.hasPermission(device)));
                        writeCommon(output, version, OP_REP_IMPORT, ST_NA);
                        continue;
                    }
                    UsbDeviceConnection connection = usbManager.openDevice(device);
                    if (connection == null) {
                        Log.w(TAG, "USB/IP could not open device: busid=" + requestedBusId);
                        writeCommon(output, version, OP_REP_IMPORT, ST_NA);
                        continue;
                    }
                    DeviceSession session = new DeviceSession(
                            socket, input, output, device, connection);
                    deviceSessions.add(session);
                    try {
                        if (!session.prepare()) {
                            Log.w(TAG, "USB/IP could not claim device: busid="
                                    + requestedBusId);
                            writeCommon(output, version, OP_REP_IMPORT, ST_NA);
                            continue;
                        }
                        writeCommon(output, version, OP_REP_IMPORT, ST_OK);
                        writeDevice(output, device, connection, false);
                        output.flush();
                        Log.i(TAG, "USB/IP device imported: " + deviceLabel(device));
                        session.run();
                    } finally {
                        deviceSessions.remove(session);
                        session.close();
                    }
                    return;
                } else {
                    throw new IOException("unsupported USB/IP opcode 0x"
                            + Integer.toHexString(opcode));
                }
            }
        } catch (IOException exception) {
            if (running.get()) {
                Log.i(TAG, "USB/IP client ended: " + exception.getMessage());
            }
        } finally {
            sockets.remove(socket);
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void writeDeviceList(DataOutputStream output, int version) throws IOException {
        List<UsbDevice> devices = new ArrayList<>();
        for (UsbDevice device : usbManager.getDeviceList().values()) {
            if (usbManager.hasPermission(device)) {
                devices.add(device);
            }
        }
        writeCommon(output, version, OP_REP_DEVLIST, ST_OK);
        output.writeInt(devices.size());
        Log.i(TAG, "USB/IP device list requested; exported=" + devices.size());
        for (UsbDevice device : devices) {
            // DEVLIST only needs Android's immutable device/interface
            // metadata. Opening and closing another connection here can
            // disturb an imported serial device while esptool is toggling its
            // modem-control lines. bcdDevice is optional for discovery, so
            // leave it zero and never touch the active USB handle.
            writeDevice(output, device, null, true);
        }
        output.flush();
    }

    private static void writeCommon(
            DataOutputStream output, int version, int opcode, int status) throws IOException {
        output.writeShort(version);
        output.writeShort(opcode);
        output.writeInt(status);
    }

    private static void writeDevice(
            DataOutputStream output,
            UsbDevice device,
            UsbDeviceConnection connection,
            boolean includeInterfaces) throws IOException {
        writeFixedString(output, device.getDeviceName(), 256);
        writeFixedString(output, busId(device), 32);
        output.writeInt(busNumber(device));
        output.writeInt(deviceNumber(device));
        output.writeInt(detectSpeed(device));
        output.writeShort(device.getVendorId());
        output.writeShort(device.getProductId());

        byte[] descriptors = connection == null ? null : connection.getRawDescriptors();
        int bcdDevice = descriptors != null && descriptors.length >= 14
                ? (descriptors[12] & 0xff) | ((descriptors[13] & 0xff) << 8) : 0;
        output.writeShort(bcdDevice);
        output.writeByte(device.getDeviceClass());
        output.writeByte(device.getDeviceSubclass());
        output.writeByte(device.getDeviceProtocol());
        output.writeByte(device.getConfigurationCount() == 0
                ? 0 : device.getConfiguration(0).getId());
        output.writeByte(device.getConfigurationCount());
        output.writeByte(device.getInterfaceCount());
        if (includeInterfaces) {
            for (int index = 0; index < device.getInterfaceCount(); index++) {
                UsbInterface usbInterface = device.getInterface(index);
                output.writeByte(usbInterface.getInterfaceClass());
                output.writeByte(usbInterface.getInterfaceSubclass());
                output.writeByte(usbInterface.getInterfaceProtocol());
                output.writeByte(0);
            }
        }
    }

    private final class DeviceSession implements AutoCloseable {
        private final LocalSocket socket;
        private final DataInputStream input;
        private final DataOutputStream output;
        private final UsbDevice device;
        private final UsbDeviceConnection connection;
        // USB host controllers preserve URB order for each endpoint. Running
        // every submit on a shared pool breaks that guarantee: serial DTR/RTS
        // control requests can be applied out of order and leave ESP boards in
        // normal boot mode instead of the ROM downloader. Keep a FIFO worker
        // per endpoint. Endpoint zero shares one queue across both directions;
        // bulk IN and OUT stay independent so reads cannot block writes.
        private final Map<Integer, ExecutorService> transferQueues =
                new ConcurrentHashMap<>();
        private final Map<Integer, Future<?>> active = new ConcurrentHashMap<>();
        private final Map<Integer, UsbEndpoint> endpoints = new ConcurrentHashMap<>();
        private final Map<Integer, ArrayDeque<byte[]>> pendingInput =
                new ConcurrentHashMap<>();
        private final Map<Integer, Future<?>> fastBulkOutTails =
                new ConcurrentHashMap<>();
        private final Semaphore fastBulkOutCapacity =
                new Semaphore(ESP_FAST_BULK_OUT_BYTES);
        private final AtomicBoolean open = new AtomicBoolean(true);
        private final AtomicBoolean espFastMode = new AtomicBoolean();
        private final AtomicBoolean fastBulkOutFailed = new AtomicBoolean();
        private final AtomicLong fastBulkOutRequests = new AtomicLong();
        private final AtomicLong fastBulkOutBytes = new AtomicLong();
        private final boolean jLink;
        private final String sessionBusId;
        private final long sessionStartedNanos = System.nanoTime();
        private final AtomicInteger traceLines = new AtomicInteger();
        private final AtomicInteger submitCount = new AtomicInteger();
        private final AtomicInteger completionCount = new AtomicInteger();
        private final AtomicInteger failureCount = new AtomicInteger();
        private final AtomicInteger unlinkCount = new AtomicInteger();
        DeviceSession(
                LocalSocket socket,
                DataInputStream input,
                DataOutputStream output,
                UsbDevice device,
                UsbDeviceConnection connection) {
            this.socket = socket;
            this.input = input;
            this.output = output;
            this.device = device;
            this.connection = connection;
            this.jLink = isJLink(device);
            this.sessionBusId = busId(device);
        }

        boolean prepare() {
            if (jLink) {
                byte[] descriptors = connection.getRawDescriptors();
                traceJLink("prepare product=" + device.getProductName()
                        + " deviceId=" + device.getDeviceId()
                        + " class=0x" + Integer.toHexString(device.getDeviceClass())
                        + " subclass=0x" + Integer.toHexString(device.getDeviceSubclass())
                        + " protocol=0x" + Integer.toHexString(device.getDeviceProtocol())
                        + " configurations=" + device.getConfigurationCount()
                        + " interfaces=" + device.getInterfaceCount()
                        + " rawDescriptors=" + (descriptors == null ? 0 : descriptors.length));
            }
            UsbConfiguration configuration = device.getConfigurationCount() == 0
                    ? null : device.getConfiguration(0);
            if (configuration != null) {
                boolean configured = connection.setConfiguration(configuration);
                traceJLink("set-configuration id=" + configuration.getId()
                        + " result=" + configured);
            }
            boolean claimedAny = false;
            for (int index = 0; index < device.getInterfaceCount(); index++) {
                UsbInterface usbInterface = device.getInterface(index);
                boolean claimed = connection.claimInterface(usbInterface, true);
                if (claimed) {
                    claimedAny = true;
                }
                traceJLink("claim-interface index=" + index
                        + " id=" + usbInterface.getId()
                        + " alternate=" + usbInterface.getAlternateSetting()
                        + " class=0x" + Integer.toHexString(usbInterface.getInterfaceClass())
                        + " subclass=0x"
                        + Integer.toHexString(usbInterface.getInterfaceSubclass())
                        + " protocol=0x"
                        + Integer.toHexString(usbInterface.getInterfaceProtocol())
                        + " endpoints=" + usbInterface.getEndpointCount()
                        + " result=" + claimed);
                for (int endpointIndex = 0;
                     endpointIndex < usbInterface.getEndpointCount();
                     endpointIndex++) {
                    UsbEndpoint endpoint = usbInterface.getEndpoint(endpointIndex);
                    endpoints.put(endpoint.getAddress(), endpoint);
                    traceJLink("endpoint interface=" + usbInterface.getId()
                            + " index=" + endpointIndex
                            + " address=0x" + Integer.toHexString(endpoint.getAddress())
                            + " direction=" + directionName(endpoint.getDirection())
                            + " type=" + transferTypeName(endpoint.getType())
                            + " maxPacket=" + endpoint.getMaxPacketSize()
                            + " interval=" + endpoint.getInterval());
                }
            }
            boolean prepared = claimedAny || device.getInterfaceCount() == 0;
            traceJLink("prepare-complete result=" + prepared);
            return prepared;
        }

        void run() throws IOException {
            try {
                while (open.get()) {
                    byte[] headerBytes = new byte[48];
                    input.readFully(headerBytes);
                    ByteBuffer header = ByteBuffer.wrap(headerBytes)
                            .order(ByteOrder.BIG_ENDIAN);
                    int command = header.getInt();
                    int sequence = header.getInt();
                    int deviceId = header.getInt();
                    int direction = header.getInt();
                    int endpoint = header.getInt();
                    if (command == USBIP_CMD_SUBMIT) {
                        int transferFlags = header.getInt();
                        int transferLength = header.getInt();
                        int startFrame = header.getInt();
                        int packetCount = header.getInt();
                        int interval = header.getInt();
                        byte[] setup = new byte[8];
                        header.get(setup);
                        if (transferLength < 0 || transferLength > MAX_TRANSFER) {
                            throw new IOException("invalid USB/IP transfer length "
                                    + transferLength);
                        }
                        byte[] outData = direction == USBIP_DIR_OUT
                                ? readBytes(input, transferLength) : new byte[0];
                        if (packetCount != 0 && packetCount != -1) {
                            int descriptorBytes = Math.multiplyExact(packetCount, 16);
                            readBytes(input, descriptorBytes);
                            writeSubmitReply(
                                    sequence, deviceId, direction, endpoint,
                                    EIO, 0, new byte[0]);
                            continue;
                        }
                        Submit submit = new Submit(
                                sequence, deviceId, direction, endpoint,
                                transferFlags, transferLength, startFrame,
                                interval, setup, outData);
                        submitCount.incrementAndGet();
                        traceJLink("submit sequence=" + sequence
                                + " direction=" + usbIpDirectionName(direction)
                                + " endpoint=0x" + Integer.toHexString(endpoint)
                                + " length=" + transferLength
                                + " flags=0x" + Integer.toHexString(transferFlags)
                                + " startFrame=" + startFrame
                                + " packets=" + packetCount
                                + " interval=" + interval
                                + (endpoint == 0 ? " setup=" + hexBytes(setup) : ""));
                        if (isEspFastBulkOut(submit)) {
                            Future<?> tail = enqueueEspFastBulkOut(submit);
                            fastBulkOutTails.put(submit.endpoint, tail);
                            fastBulkOutRequests.incrementAndGet();
                            fastBulkOutBytes.addAndGet(submit.outData.length);
                            continue;
                        }
                        List<Future<?>> writeBarriers = espFastMode.get()
                                && (submit.endpoint == 0 || submit.direction == USBIP_DIR_IN)
                                ? snapshotFastBulkOutTails() : List.of();
                        FutureTask<Void> task = new FutureTask<>(() -> {
                            execute(submit, writeBarriers);
                            return null;
                        });
                        active.put(sequence, task);
                        transferQueue(submit).execute(task);
                    } else if (command == USBIP_CMD_UNLINK) {
                        int unlinkSequence = header.getInt();
                        Future<?> future = active.remove(unlinkSequence);
                        if (future != null) {
                            future.cancel(true);
                        }
                        unlinkCount.incrementAndGet();
                        traceJLink("unlink sequence=" + sequence
                                + " targetSequence=" + unlinkSequence
                                + " endpoint=0x" + Integer.toHexString(endpoint)
                                + " active=" + (future != null));
                        writeUnlinkReply(
                                sequence, deviceId, direction, endpoint,
                                future == null ? ECONNRESET : ST_OK);
                    } else {
                        throw new IOException("unsupported USB/IP command " + command);
                    }
                }
            } finally {
                close();
            }
        }

        boolean isForDevice(UsbDevice candidate) {
            return candidate != null
                    && (device.getDeviceId() == candidate.getDeviceId()
                    || device.getDeviceName().equals(candidate.getDeviceName()));
        }

        private void execute(Submit submit, List<Future<?>> writeBarriers) {
            long startedNanos = System.nanoTime();
            int status = ST_OK;
            int actualLength = 0;
            byte[] response = new byte[0];
            try {
                awaitFastBulkOut(writeBarriers);
                if (submit.endpoint == 0) {
                    TransferResult result = executeControl(submit);
                    status = result.status;
                    actualLength = result.actualLength;
                    response = result.data;
                } else {
                    UsbEndpoint endpoint = endpoints.get(
                            submit.endpoint | (submit.direction == USBIP_DIR_IN ? 0x80 : 0));
                    if (endpoint == null) {
                        status = EIO;
                    } else {
                        byte[] buffer;
                        int result;
                        if (submit.direction == USBIP_DIR_IN) {
                            buffer = takePendingInput(
                                    endpoint.getAddress(), submit.transferLength);
                            if (buffer.length > 0) {
                                result = buffer.length;
                            } else {
                                buffer = new byte[submit.transferLength];
                                int attempts = 0;
                                do {
                                    result = connection.bulkTransfer(
                                            endpoint, buffer, buffer.length,
                                            BULK_IN_POLL_TIMEOUT_MS);
                                    attempts++;
                                    if (result < 0
                                            && (attempts <= 3 || attempts % 10 == 0)) {
                                        traceJLink("bulk-in-wait sequence="
                                                + submit.sequence
                                                + " endpoint=0x"
                                                + Integer.toHexString(endpoint.getAddress())
                                                + " attempt=" + attempts);
                                    }
                                } while (result < 0
                                        && open.get()
                                        && !Thread.currentThread().isInterrupted());
                            }
                        } else {
                            buffer = submit.outData;
                            result = connection.bulkTransfer(
                                    endpoint, buffer, buffer.length, BULK_OUT_TIMEOUT_MS);
                        }
                        if (Thread.currentThread().isInterrupted()) {
                            preserveCancelledInput(submit, endpoint, buffer, result);
                            return;
                        }
                        if (result < 0) {
                            status = EIO;
                        } else {
                            actualLength = result;
                            if (submit.direction == USBIP_DIR_IN) {
                                response = Arrays.copyOf(buffer, result);
                            }
                        }
                    }
                }
                completionCount.incrementAndGet();
                if (status != ST_OK) {
                    failureCount.incrementAndGet();
                }
                traceJLink("complete sequence=" + submit.sequence
                        + " status=" + status
                        + " actualLength=" + actualLength
                        + " elapsedMs=" + elapsedMillis(startedNanos));
                if (active.remove(submit.sequence) == null) {
                    if (submit.direction == USBIP_DIR_IN && actualLength > 0) {
                        addPendingInput(
                                submit.endpoint | 0x80,
                                Arrays.copyOf(response, actualLength));
                    }
                    return;
                }
                if (Thread.currentThread().isInterrupted()) {
                    return;
                }
                writeSubmitReply(
                        submit.sequence, submit.deviceId, submit.direction,
                        submit.endpoint, status, actualLength, response);
            } catch (Throwable throwable) {
                active.remove(submit.sequence);
                failureCount.incrementAndGet();
                traceJLink("exception sequence=" + submit.sequence
                        + " type=" + throwable.getClass().getSimpleName()
                        + " message=" + throwable.getMessage());
                if (open.get() && !Thread.currentThread().isInterrupted()) {
                    Log.w(TAG, "USB/IP transfer failed", throwable);
                    try {
                        writeSubmitReply(
                                submit.sequence, submit.deviceId, submit.direction,
                                submit.endpoint, EIO, 0, new byte[0]);
                    } catch (IOException ignored) {
                        close();
                    }
                }
            }
        }

        private ExecutorService transferQueue(Submit submit) {
            int key = submit.endpoint == 0
                    ? 0
                    : submit.endpoint
                    | (submit.direction == USBIP_DIR_IN ? 0x80 : 0);
            return transferQueues.computeIfAbsent(
                    key, ignored -> Executors.newSingleThreadExecutor());
        }

        private boolean isEspFastBulkOut(Submit submit) {
            if (!espFastMode.get()
                    || device.getVendorId() != CP210X_VENDOR_ID
                    || submit.endpoint == 0
                    || submit.direction != USBIP_DIR_OUT
                    || submit.outData.length == 0
                    || submit.outData.length > ESP_FAST_BULK_OUT_BYTES) {
                return false;
            }
            UsbEndpoint endpoint = endpoints.get(submit.endpoint);
            return endpoint != null
                    && endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK;
        }

        private Future<?> enqueueEspFastBulkOut(Submit submit) throws IOException {
            try {
                fastBulkOutCapacity.acquire(submit.outData.length);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("ESP fast bulk-write queue interrupted", interrupted);
            }
            try {
                UsbEndpoint endpoint = endpoints.get(submit.endpoint);
                return transferQueue(submit).submit(() -> {
                    try {
                        int result = connection.bulkTransfer(
                                endpoint, submit.outData, submit.outData.length,
                                BULK_OUT_TIMEOUT_MS);
                        if (result != submit.outData.length) {
                            fastBulkOutFailed.set(true);
                            failureCount.incrementAndGet();
                            Log.e(TAG, "ESP fast USB/IP bulk write failed endpoint=0x"
                                    + Integer.toHexString(endpoint.getAddress())
                                    + " expected=" + submit.outData.length
                                    + " actual=" + result);
                            close();
                        } else {
                            completionCount.incrementAndGet();
                        }
                    } finally {
                        fastBulkOutCapacity.release(submit.outData.length);
                    }
                });
            } catch (RuntimeException exception) {
                fastBulkOutCapacity.release(submit.outData.length);
                throw new IOException("Unable to queue ESP fast bulk write", exception);
            }
        }

        private List<Future<?>> snapshotFastBulkOutTails() {
            return new ArrayList<>(fastBulkOutTails.values());
        }

        private void awaitFastBulkOut(List<Future<?>> barriers) throws IOException {
            for (Future<?> barrier : barriers) {
                try {
                    barrier.get(30, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("ESP fast bulk-write drain interrupted", interrupted);
                } catch (Exception exception) {
                    throw new IOException("ESP fast bulk-write drain failed", exception);
                }
            }
            if (fastBulkOutFailed.get()) {
                throw new IOException("ESP fast bulk write failed");
            }
        }

        private void preserveCancelledInput(
                Submit submit, UsbEndpoint endpoint, byte[] buffer, int result) {
            if (submit.direction != USBIP_DIR_IN || result <= 0) {
                return;
            }
            addPendingInput(endpoint.getAddress(), Arrays.copyOf(buffer, result));
            Log.i(TAG, "USB/IP preserved " + result
                    + " bytes from cancelled IN transfer endpoint=0x"
                    + Integer.toHexString(endpoint.getAddress()));
        }

        private void addPendingInput(int endpointAddress, byte[] data) {
            if (data.length > 0) {
                pendingInput.computeIfAbsent(
                        endpointAddress, ignored -> new ArrayDeque<>()).addLast(data);
            }
        }

        private byte[] takePendingInput(int endpointAddress, int maximumLength) {
            ArrayDeque<byte[]> queue = pendingInput.get(endpointAddress);
            if (queue == null || queue.isEmpty() || maximumLength == 0) {
                return new byte[0];
            }
            byte[] data = queue.removeFirst();
            if (data.length <= maximumLength) {
                if (queue.isEmpty()) {
                    pendingInput.remove(endpointAddress, queue);
                }
                return data;
            }
            byte[] result = Arrays.copyOf(data, maximumLength);
            queue.addFirst(Arrays.copyOfRange(data, maximumLength, data.length));
            return result;
        }

        private TransferResult executeControl(Submit submit) {
            ByteBuffer setup = ByteBuffer.wrap(submit.setup).order(ByteOrder.LITTLE_ENDIAN);
            int requestType = setup.get() & 0xff;
            int request = setup.get() & 0xff;
            int value = setup.getShort() & 0xffff;
            int index = setup.getShort() & 0xffff;
            int length = setup.getShort() & 0xffff;
            int boundedLength = Math.min(length, submit.transferLength);

            if (requestType == 0 && request == 9) {
                return new TransferResult(
                        setConfiguration(value) ? ST_OK : EIO, 0, new byte[0]);
            }
            if (requestType == 1 && request == 11) {
                return new TransferResult(
                        setInterface(index, value) ? ST_OK : EIO, 0, new byte[0]);
            }
            boolean inputTransfer = (requestType & UsbConstants.USB_DIR_IN) != 0;
            byte[] data = inputTransfer
                    ? new byte[boundedLength]
                    : Arrays.copyOf(submit.outData, boundedLength);
            int result = connection.controlTransfer(
                    requestType, request, value, index, data, boundedLength,
                    CONTROL_TRANSFER_TIMEOUT_MS);
            traceJLink("control-result sequence=" + submit.sequence
                    + " type=0x" + Integer.toHexString(requestType)
                    + " request=0x" + Integer.toHexString(request)
                    + " value=0x" + Integer.toHexString(value)
                    + " index=0x" + Integer.toHexString(index)
                    + " requested=" + boundedLength
                    + " result=" + result);
            if (isCp210xMhs(requestType, request)) {
                Log.i(TAG, "USB/IP CP210x modem control pass-through value=0x"
                        + Integer.toHexString(value) + " index=" + index
                        + " result=" + result);
            } else if (result < 0) {
                Log.w(TAG, "USB/IP control transfer failed type=0x"
                        + Integer.toHexString(requestType) + " request=0x"
                        + Integer.toHexString(request) + " value=0x"
                        + Integer.toHexString(value) + " index=" + index);
            }
            if (result < 0) {
                return new TransferResult(EIO, 0, new byte[0]);
            }
            return new TransferResult(
                    ST_OK,
                    result,
                    inputTransfer ? Arrays.copyOf(data, result) : new byte[0]);
        }

        private boolean isCp210xMhs(int requestType, int request) {
            return device.getVendorId() == CP210X_VENDOR_ID
                    && requestType == CP210X_REQUEST_TYPE
                    && request == CP210X_SET_MHS;
        }

        private int setCp210xMhs(int value, int index) {
            return connection.controlTransfer(
                    CP210X_REQUEST_TYPE, CP210X_SET_MHS, value, index,
                    new byte[0], 0, CONTROL_TRANSFER_TIMEOUT_MS);
        }

        private boolean sleepResetStep(long milliseconds) {
            try {
                Thread.sleep(milliseconds);
                return true;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }

        void executeDeviceControl(String action) throws IOException {
            if (device.getVendorId() != CP210X_VENDOR_ID) {
                throw new IOException("ESP32 device control requires a CP210x USB bridge");
            }
            Future<Integer> result = transferQueues
                    .computeIfAbsent(0, ignored -> Executors.newSingleThreadExecutor())
                    .submit(() -> runDeviceControl(action));
            try {
                int status = result.get(
                        "esp32.usbip-fast-mode.disable".equals(action) ? 35 : 5,
                        TimeUnit.SECONDS);
                if (status < 0) {
                    throw new IOException("ESP32 USB device control failed");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("ESP32 reset was interrupted", interrupted);
            } catch (Exception exception) {
                result.cancel(true);
                throw new IOException("ESP32 reset failed: " + exception.getMessage(), exception);
            }
        }

        private int runDeviceControl(String action) {
            if ("esp32.usbip-fast-mode.enable".equals(action)) {
                fastBulkOutFailed.set(false);
                fastBulkOutRequests.set(0);
                fastBulkOutBytes.set(0);
                espFastMode.set(true);
                Log.i(TAG, "ESP esptool USB/IP fast bulk-write mode enabled");
                return ST_OK;
            }
            if ("esp32.usbip-fast-mode.disable".equals(action)) {
                espFastMode.set(false);
                try {
                    awaitFastBulkOut(snapshotFastBulkOutTails());
                    fastBulkOutTails.clear();
                    Log.i(TAG, "ESP esptool USB/IP fast bulk-write mode disabled requests="
                            + fastBulkOutRequests.get() + " bytes=" + fastBulkOutBytes.get());
                    return ST_OK;
                } catch (IOException exception) {
                    Log.e(TAG, "Unable to drain ESP fast bulk writes", exception);
                    return EIO;
                }
            }
            if ("esp32.enter-bootloader".equals(action)) {
                int[] prefix = {0x300, 0x303, 0x302};
                for (int value : prefix) {
                    int result = setCp210xMhs(value, 0);
                    if (result < 0) return result;
                }
                if (!sleepResetStep(100)) return EIO;
                int result = setCp210xMhs(0x301, 0);
                if (result < 0) return result;
                if (!sleepResetStep(100)) return EIO;
                result = setCp210xMhs(0x300, 0);
                if (result < 0) return result;
                result = setCp210xMhs(0x100, 0);
                if (result >= 0) {
                    Log.i(TAG, "Server-requested ESP32 bootloader reset completed");
                }
                return result;
            }
            if ("esp32.run-app".equals(action)) {
                int result = setCp210xMhs(0x302, 0);
                if (result < 0) return result;
                if (!sleepResetStep(100)) return EIO;
                result = setCp210xMhs(0x300, 0);
                if (result < 0) return result;
                result = setCp210xMhs(0x100, 0);
                if (result >= 0) {
                    Log.i(TAG, "Server-requested ESP32 application reset completed");
                }
                return result;
            }
            throw new IllegalArgumentException("Unsupported device control action: " + action);
        }

        private boolean setConfiguration(int id) {
            for (int index = 0; index < device.getConfigurationCount(); index++) {
                UsbConfiguration configuration = device.getConfiguration(index);
                if (configuration.getId() == id) {
                    connection.setConfiguration(configuration);
                    return true;
                }
            }
            return false;
        }

        private boolean setInterface(int interfaceId, int alternateSetting) {
            for (int index = 0; index < device.getInterfaceCount(); index++) {
                UsbInterface usbInterface = device.getInterface(index);
                if (usbInterface.getId() == interfaceId
                        && usbInterface.getAlternateSetting() == alternateSetting) {
                    return connection.setInterface(usbInterface);
                }
            }
            return false;
        }

        private void writeSubmitReply(
                int sequence,
                int deviceId,
                int direction,
                int endpoint,
                int status,
                int actualLength,
                byte[] data) throws IOException {
            synchronized (output) {
                writeDeviceHeader(
                        output, USBIP_RET_SUBMIT, sequence, deviceId, direction, endpoint);
                output.writeInt(status);
                output.writeInt(actualLength);
                output.writeInt(0);
                output.writeInt(0);
                output.writeInt(0);
                output.writeLong(0);
                if (direction == USBIP_DIR_IN && actualLength > 0) {
                    output.write(data, 0, actualLength);
                }
                output.flush();
            }
        }

        private void writeUnlinkReply(
                int sequence,
                int deviceId,
                int direction,
                int endpoint,
                int status) throws IOException {
            synchronized (output) {
                writeDeviceHeader(
                        output, USBIP_RET_UNLINK, sequence, deviceId, direction, endpoint);
                output.writeInt(status);
                output.write(new byte[24]);
                output.flush();
            }
        }

        @Override
        public void close() {
            if (!open.compareAndSet(true, false)) {
                return;
            }
            if (jLink) {
                Log.i(TAG, "USB/IP J-Link " + sessionBusId
                        + " session-close durationMs=" + elapsedMillis(sessionStartedNanos)
                        + " submits=" + submitCount.get()
                        + " completions=" + completionCount.get()
                        + " unlinks=" + unlinkCount.get()
                        + " failures=" + failureCount.get()
                        + " active=" + active.size());
            }
            for (Future<?> future : active.values()) {
                future.cancel(true);
            }
            active.clear();
            for (ExecutorService queue : transferQueues.values()) {
                queue.shutdownNow();
            }
            transferQueues.clear();
            pendingInput.clear();
            for (int index = 0; index < device.getInterfaceCount(); index++) {
                connection.releaseInterface(device.getInterface(index));
            }
            connection.close();
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }

        private void traceJLink(String message) {
            if (!jLink) {
                return;
            }
            int line = traceLines.incrementAndGet();
            if (line <= JLINK_TRACE_LIMIT) {
                Log.i(TAG, "USB/IP J-Link " + sessionBusId + " " + message);
            } else if (line == JLINK_TRACE_LIMIT + 1) {
                Log.i(TAG, "USB/IP J-Link " + sessionBusId
                        + " trace limit reached; suppressing further per-transfer logs");
            }
        }
    }

    private static void writeDeviceHeader(
            DataOutputStream output,
            int command,
            int sequence,
            int deviceId,
            int direction,
            int endpoint) throws IOException {
        output.writeInt(command);
        output.writeInt(sequence);
        output.writeInt(deviceId);
        output.writeInt(direction);
        output.writeInt(endpoint);
    }

    private void requestPermission(UsbDevice device) {
        if (device == null || usbManager.hasPermission(device)) {
            return;
        }
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(ACTION_USB_PERMISSION).setPackage(context.getPackageName());
        PendingIntent permissionIntent = PendingIntent.getBroadcast(
                context, device.getDeviceId(), intent, flags);
        usbManager.requestPermission(device, permissionIntent);
    }

    private void closeSessions(UsbDevice device) {
        for (DeviceSession session : deviceSessions) {
            if (session.isForDevice(device)) {
                Log.i(TAG, "Closing detached USB/IP session for " + deviceLabel(device));
                session.close();
            }
        }
    }

    private UsbDevice findDevice(String requestedBusId) {
        for (UsbDevice device : usbManager.getDeviceList().values()) {
            if (busId(device).equals(requestedBusId)) {
                return device;
            }
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private static UsbDevice usbDeviceExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
        }
        return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
    }

    private static int busNumber(UsbDevice device) {
        return device.getDeviceId() / 1000;
    }

    private static int deviceNumber(UsbDevice device) {
        return device.getDeviceId() % 1000;
    }

    private static String busId(UsbDevice device) {
        return busNumber(device) + "-" + deviceNumber(device);
    }

    private static String deviceLabel(UsbDevice device) {
        if (device == null) {
            return "unknown";
        }
        String product = device.getProductName();
        return (product == null ? "USB device" : product)
                + " [" + String.format("%04x:%04x",
                device.getVendorId(), device.getProductId()) + "]"
                + " busid=" + busId(device);
    }

    private static boolean isJLink(UsbDevice device) {
        return device != null && device.getVendorId() == SEGGER_VENDOR_ID;
    }

    private static String directionName(int direction) {
        return direction == UsbConstants.USB_DIR_IN ? "in" : "out";
    }

    private static String usbIpDirectionName(int direction) {
        return direction == USBIP_DIR_IN ? "in" : "out";
    }

    private static String transferTypeName(int type) {
        switch (type) {
            case UsbConstants.USB_ENDPOINT_XFER_CONTROL:
                return "control";
            case UsbConstants.USB_ENDPOINT_XFER_ISOC:
                return "isochronous";
            case UsbConstants.USB_ENDPOINT_XFER_BULK:
                return "bulk";
            case UsbConstants.USB_ENDPOINT_XFER_INT:
                return "interrupt";
            default:
                return "unknown(" + type + ")";
        }
    }

    private static String hexBytes(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) {
            result.append(String.format("%02x", item & 0xff));
        }
        return result.toString();
    }

    private static long elapsedMillis(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000L;
    }

    private static int detectSpeed(UsbDevice device) {
        int speed = 2; // full speed
        for (int interfaceIndex = 0;
             interfaceIndex < device.getInterfaceCount();
             interfaceIndex++) {
            UsbInterface usbInterface = device.getInterface(interfaceIndex);
            for (int endpointIndex = 0;
                 endpointIndex < usbInterface.getEndpointCount();
                 endpointIndex++) {
                UsbEndpoint endpoint = usbInterface.getEndpoint(endpointIndex);
                if (endpoint.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) {
                    continue;
                }
                if (endpoint.getMaxPacketSize() >= 1024) {
                    return 5; // super speed
                }
                if (endpoint.getMaxPacketSize() >= 512) {
                    speed = 3; // high speed
                }
            }
        }
        return speed;
    }

    private static String cString(byte[] value) {
        int length = 0;
        while (length < value.length && value[length] != 0) {
            length++;
        }
        return new String(value, 0, length, StandardCharsets.US_ASCII);
    }

    private static byte[] readBytes(DataInputStream input, int length) throws IOException {
        byte[] value = new byte[length];
        input.readFully(value);
        return value;
    }

    private static void writeFixedString(
            DataOutputStream output, String value, int length) throws IOException {
        byte[] encoded = value == null
                ? new byte[0] : value.getBytes(StandardCharsets.US_ASCII);
        int count = Math.min(encoded.length, length - 1);
        output.write(encoded, 0, count);
        output.write(new byte[length - count]);
    }

    @Override
    public void close() {
        if (!running.compareAndSet(true, false)) {
            return;
        }
        if (receiverRegistered.compareAndSet(true, false)) {
            try {
                context.unregisterReceiver(usbReceiver);
            } catch (IllegalArgumentException ignored) {
            }
        }
        LocalServerSocket currentListener = listener;
        listener = null;
        if (currentListener != null) {
            try {
                currentListener.close();
            } catch (IOException ignored) {
            }
        }
        for (DeviceSession session : deviceSessions) {
            session.close();
        }
        deviceSessions.clear();
        for (LocalSocket socket : sockets) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
        sockets.clear();
        clients.shutdownNow();
        try {
            if (!clients.awaitTermination(2, TimeUnit.SECONDS)) {
                Log.w(TAG, "USB/IP worker shutdown timed out");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        Log.i(TAG, "USB/IP server stopped and socket @" + socketName + " released");
    }

    private static final class Submit {
        final int sequence;
        final int deviceId;
        final int direction;
        final int endpoint;
        final int transferFlags;
        final int transferLength;
        final int startFrame;
        final int interval;
        final byte[] setup;
        final byte[] outData;

        Submit(
                int sequence,
                int deviceId,
                int direction,
                int endpoint,
                int transferFlags,
                int transferLength,
                int startFrame,
                int interval,
                byte[] setup,
                byte[] outData) {
            this.sequence = sequence;
            this.deviceId = deviceId;
            this.direction = direction;
            this.endpoint = endpoint;
            this.transferFlags = transferFlags;
            this.transferLength = transferLength;
            this.startFrame = startFrame;
            this.interval = interval;
            this.setup = setup;
            this.outData = outData;
        }
    }

    private static final class TransferResult {
        final int status;
        final int actualLength;
        final byte[] data;

        TransferResult(int status, int actualLength, byte[] data) {
            this.status = status;
            this.actualLength = actualLength;
            this.data = data;
        }
    }
}

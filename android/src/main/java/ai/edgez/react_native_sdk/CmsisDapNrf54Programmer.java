/*
 * Copyright (c) 2010-2023 Nordic Semiconductor ASA. All rights reserved.
 * Copyright (c) 2025 StarSphere. All rights reserved.
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 *
 * The nRF54L15 flash-algorithm data and execution model are adapted from
 * pyOCD and the nrf_ocd translation of that implementation.
 */
package ai.edgez.react_native_sdk;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/** Programs nRF54L flash through a CMSIS-DAP v2 bulk interface. */
final class CmsisDapNrf54Programmer implements AutoCloseable {
    interface ProgressListener {
        void onProgress(long completed, long total, String message) throws IOException;
    }

    private static final int USB_TIMEOUT_MS = 5_000;
    private static final int DAP_INFO = 0x00;
    private static final int DAP_CONNECT = 0x02;
    private static final int DAP_DISCONNECT = 0x03;
    private static final int DAP_TRANSFER_CONFIGURE = 0x04;
    private static final int DAP_TRANSFER = 0x05;
    private static final int DAP_TRANSFER_BLOCK = 0x06;
    private static final int DAP_RESET_TARGET = 0x0A;
    private static final int DAP_SWJ_CLOCK = 0x11;
    private static final int DAP_SWJ_SEQUENCE = 0x12;
    private static final int DAP_SWD_CONFIGURE = 0x13;
    private static final int DAP_OK = 1;
    private static final int DAP_WAIT = 2;
    private static final int DAP_NO_ACK = 7;
    private static final int TRANSFER_RETRIES = 50;
    private static final int DP_CTRL_STAT = 0x04;
    private static final int DP_SELECT = 0x08;
    private static final int DP_RDBUFF = 0x0C;
    private static final int AP = 1;
    private static final int READ = 2;
    private static final int AP_CSW = AP | 0x00;
    private static final int AP_TAR = AP | 0x04;
    private static final int AP_DRW = AP | 0x0C;
    private static final int MEM_AP_CSW = 0x03000052;
    private static final int DHCSR = 0xE000EDF0;
    private static final int DCRSR = 0xE000EDF4;
    private static final int DCRDR = 0xE000EDF8;
    private static final int DFSR = 0xE000ED30;
    private static final int DHCSR_HALT = 0xA05F0003;
    private static final int DHCSR_RUN = 0xA05F0001;
    private static final int S_REGRDY = 1 << 16;
    private static final int S_HALT = 1 << 17;
    private static final int AIRCR = 0xE000ED0C;
    private static final int AIRCR_SYSRESETREQ = 0x05FA0004;
    private static final int ALGO_LOAD_ADDRESS = 0x20000000;
    private static final int ALGO_PC_INIT = 0x20000015;
    private static final int ALGO_PC_UNINIT = 0x20000019;
    private static final int ALGO_PC_PROGRAM_PAGE = 0x20000065;
    private static final int ALGO_STATIC_BASE = 0x200000A4;
    private static final int ALGO_STACK = 0x20000300;
    private static final int ALGO_PAGE_BUFFER = 0x20001000;
    private static final int PROGRAM_CHUNK_BYTES = 1024;
    private static final int NRF54L15_RRAM_SIZE = 0x17D000;
    // Apache-2.0: adapted from pyOCD's Nordic nRF54L15 flash algorithm.
    private static final int[] FLASH_ALGORITHM = {
        0xE00ABE00,
        0xf8d24a02, 0x2b013400, 0x4770d1fb, 0x5004b000, 0x47702000, 0x47702000, 0x49072001, 0xf8c1b508,
        0xf7ff0500, 0xf8c1ffed, 0x20000540, 0xffe8f7ff, 0x0500f8c1, 0xbf00bd08, 0x5004b000, 0x2301b508,
        0xf8c14906, 0xf7ff3500, 0xf04fffdb, 0x600333ff, 0xf7ff2000, 0xf8c1ffd5, 0xbd080500, 0x5004b000,
        0x2301b538, 0x4d0c4614, 0x0103f021, 0x3500f8c5, 0xffc6f7ff, 0x44214622, 0x42911b00, 0x2000d105,
        0xffbef7ff, 0x0500f8c5, 0x4613bd38, 0x4b04f853, 0x461a5014, 0xbf00e7f1, 0x5004b000, 0x00000000,
    };

    private final UsbDeviceConnection connection;
    private final UsbInterface dapInterface;
    private final UsbEndpoint output;
    private final UsbEndpoint input;
    private int packetSize;

    CmsisDapNrf54Programmer(UsbDevice device, UsbDeviceConnection connection) throws IOException {
        this.connection = connection;
        UsbInterface selected = null;
        UsbEndpoint selectedOut = null;
        UsbEndpoint selectedIn = null;
        for (int interfaceIndex = 0; interfaceIndex < device.getInterfaceCount(); interfaceIndex++) {
            UsbInterface candidate = device.getInterface(interfaceIndex);
            UsbEndpoint candidateOut = null;
            UsbEndpoint candidateIn = null;
            for (int endpointIndex = 0; endpointIndex < candidate.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = candidate.getEndpoint(endpointIndex);
                if (endpoint.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
                if (endpoint.getDirection() == UsbConstants.USB_DIR_IN) candidateIn = endpoint;
                else candidateOut = endpoint;
            }
            if (candidateOut != null && candidateIn != null) {
                selected = candidate;
                selectedOut = candidateOut;
                selectedIn = candidateIn;
                break;
            }
        }
        if (selected == null || !connection.claimInterface(selected, true)) {
            throw new IOException("CMSIS-DAP bulk interface is unavailable");
        }
        dapInterface = selected;
        output = selectedOut;
        input = selectedIn;
        packetSize = Math.max(64, Math.min(512, Math.max(output.getMaxPacketSize(), input.getMaxPacketSize())));
    }

    void program(File ihex, ProgressListener progress) throws IOException {
        List<Segment> segments = parseIHex(ihex);
        long total = 0;
        for (Segment segment : segments) {
            long end = Integer.toUnsignedLong(segment.address) + segment.data.length;
            if (segment.address < 0 || end > NRF54L15_RRAM_SIZE) {
                throw new IOException("Intel HEX segment is outside nRF54L15 RRAM at 0x"
                        + Integer.toHexString(segment.address));
            }
            total += segment.data.length;
        }
        byte[] packetInfo = command(DAP_INFO, new byte[]{(byte) 0xFF});
        if (packetInfo.length >= 4 && (packetInfo[1] & 0xFF) >= 2) {
            int advertised = Short.toUnsignedInt(
                    ByteBuffer.wrap(packetInfo, 2, 2).order(ByteOrder.LITTLE_ENDIAN).getShort());
            if (advertised >= 64 && advertised <= 512) packetSize = advertised;
        }
        byte[] connected = command(DAP_CONNECT, new byte[]{1});
        if (connected.length < 2 || connected[1] != 1) throw new IOException("CMSIS-DAP could not enter SWD mode");
        statusCommand(DAP_SWD_CONFIGURE, new byte[]{0});
        statusCommand(DAP_SWJ_CLOCK, le32(1_000_000));
        statusCommand(DAP_TRANSFER_CONFIGURE, new byte[]{2, (byte) 150, 0, 0, 0});
        swjSequence(repeat((byte) 0xFF, 7), 51);
        swjSequence(new byte[]{(byte) 0x9E, (byte) 0xE7}, 16);
        swjSequence(repeat((byte) 0xFF, 7), 51);
        swjSequence(new byte[]{0}, 8);
        int idcode = readDpBlock(0x00);
        if (idcode == 0 || idcode == -1) throw new IOException("Invalid SWD IDCODE");
        writeDp(DP_SELECT, 0);
        writeDp(0x00, 0x1F);
        writeDp(DP_CTRL_STAT, 0x50000F00);
        boolean powered = false;
        for (int retry = 0; retry < 100; retry++) {
            if ((readDp(DP_CTRL_STAT) & 0xA0000000) == 0xA0000000) {
                powered = true;
                break;
            }
        }
        if (!powered) throw new IOException("ARM debug and system power-up acknowledgement timed out");
        writeDp(DP_SELECT, 0);
        writeAp(AP_CSW, MEM_AP_CSW);
        haltCore();
        ByteBuffer algorithm = ByteBuffer.allocate(FLASH_ALGORITHM.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int instruction : FLASH_ALGORITHM) algorithm.putInt(instruction);
        writeMemoryBytes(ALGO_LOAD_ADDRESS, algorithm.array(), 0, algorithm.array().length);
        if (readMemoryWord(ALGO_LOAD_ADDRESS) != FLASH_ALGORITHM[0]) {
            throw new IOException("nRF54L15 flash algorithm RAM verification failed");
        }
        int initResult = -1;
        IOException initFailure = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                initResult = callAlgorithm(ALGO_PC_INIT, 0, 64_000_000, 0, true);
                if (initResult == 0) break;
            } catch (IOException failure) {
                initFailure = failure;
            }
            if (attempt == 0) sleep(100);
        }
        if (initResult != 0) {
            throw new IOException("nRF54L15 flash algorithm initialization failed: " + initResult, initFailure);
        }
        long completed = 0;
        progress.onProgress(0, total, "Programming nRF54L15 flash");
        for (Segment segment : segments) {
            if ((segment.address & 3) != 0 || (segment.data.length & 3) != 0) {
                throw new IOException("Intel HEX contains an unaligned load segment at 0x" + Integer.toHexString(segment.address));
            }
            int offset = 0;
            while (offset < segment.data.length) {
                int address = segment.address + offset;
                int count = Math.min(segment.data.length - offset, PROGRAM_CHUNK_BYTES);
                writeMemoryBytes(ALGO_PAGE_BUFFER, segment.data, offset, count);
                int result = callAlgorithm(ALGO_PC_PROGRAM_PAGE, address, count, ALGO_PAGE_BUFFER, false);
                if (result != 0) throw new IOException("Flash programming failed at 0x" + Integer.toHexString(address) + ": " + result);
                offset += count;
                completed += count;
                progress.onProgress(completed, total, "Programming " + percent(completed, total) + "%");
            }
        }
        completed = 0;
        progress.onProgress(0, total, "Verifying nRF54L15 RRAM");
        for (Segment segment : segments) {
            int offset = 0;
            while (offset < segment.data.length) {
                int address = segment.address + offset;
                int count = Math.min(segment.data.length - offset, PROGRAM_CHUNK_BYTES);
                byte[] actual = readMemoryBytes(address, count);
                for (int index = 0; index < count; index++) {
                    if (actual[index] != segment.data[offset + index]) {
                        throw new IOException("Verification failed at 0x" + Integer.toHexString(address + index));
                    }
                }
                offset += count;
                completed += count;
                progress.onProgress(completed, total, "Verifying " + percent(completed, total) + "%");
            }
        }
        int uninitResult = callAlgorithm(ALGO_PC_UNINIT, 0, 0, 0, false);
        if (uninitResult != 0) throw new IOException("nRF54L15 flash algorithm cleanup failed: " + uninitResult);
        writeMemoryWord(AIRCR, AIRCR_SYSRESETREQ);
        command(DAP_RESET_TARGET, new byte[0]);
        command(DAP_DISCONNECT, new byte[0]);
    }

    private void writeMemoryWord(int address, int value) throws IOException {
        writeAp(AP_TAR, address);
        writeAp(AP_DRW, value);
        readDp(DP_RDBUFF);
    }

    private void writeMemoryBytes(int address, byte[] data, int offset, int count) throws IOException {
        int completed = 0;
        while (completed < count) {
            int currentAddress = address + completed;
            int boundaryBytes = 0x400 - (currentAddress & 0x3FF);
            int maxBytes = Math.max(4, ((packetSize - 5) / 4) * 4);
            int chunk = Math.min(count - completed, Math.min(boundaryBytes, maxBytes));
            writeAp(AP_TAR, currentAddress);
            int words = (chunk + 3) / 4;
            ByteBuffer payload = ByteBuffer.allocate(4 + words * 4).order(ByteOrder.LITTLE_ENDIAN);
            payload.put((byte) 0).putShort((short) words).put((byte) AP_DRW);
            for (int index = 0; index < words * 4; index++) {
                int source = offset + completed + index;
                payload.put(source < offset + count ? data[source] : (byte) 0xFF);
            }
            transferBlock(payload.array(), words);
            readDp(DP_RDBUFF);
            completed += chunk;
        }
    }

    private byte[] readMemoryBytes(int address, int count) throws IOException {
        byte[] result = new byte[count];
        int completed = 0;
        while (completed < count) {
            int currentAddress = address + completed;
            int boundaryBytes = 0x400 - (currentAddress & 0x3FF);
            int maxBytes = Math.max(4, ((packetSize - 4) / 4) * 4);
            int chunk = Math.min(count - completed, Math.min(boundaryBytes, maxBytes));
            int words = (chunk + 3) / 4;
            writeAp(AP_TAR, currentAddress);
            ByteBuffer payload = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
            payload.put((byte) 0).putShort((short) words).put((byte) (AP_DRW | READ));
            byte[] response = transferBlock(payload.array(), words);
            if (response.length < 4 + words * 4) throw new IOException("Short CMSIS-DAP memory response");
            System.arraycopy(response, 4, result, completed, chunk);
            readDp(DP_RDBUFF);
            completed += chunk;
        }
        return result;
    }

    private int readMemoryWord(int address) throws IOException {
        return ByteBuffer.wrap(readMemoryBytes(address, 4)).order(ByteOrder.LITTLE_ENDIAN).getInt();
    }

    private void haltCore() throws IOException {
        writeMemoryWord(DHCSR, DHCSR_HALT);
        for (int retry = 0; retry < 1000; retry++) {
            if ((readMemoryWord(DHCSR) & S_HALT) != 0) return;
            sleep(1);
        }
        throw new IOException("Timed out halting the Cortex-M33");
    }

    private void writeCoreRegister(int register, int value) throws IOException {
        writeMemoryWord(DCRDR, value);
        writeMemoryWord(DCRSR, register | (1 << 16));
        waitRegisterReady();
    }

    private int readCoreRegister(int register) throws IOException {
        writeMemoryWord(DCRSR, register);
        waitRegisterReady();
        return readMemoryWord(DCRDR);
    }

    private void waitRegisterReady() throws IOException {
        for (int retry = 0; retry < 100; retry++) {
            if ((readMemoryWord(DHCSR) & S_REGRDY) != 0) return;
            sleep(1);
        }
        throw new IOException("Timed out accessing a Cortex-M33 register");
    }

    private int callAlgorithm(int pc, int r0, int r1, int r2, boolean initialize) throws IOException {
        writeCoreRegister(15, pc);
        writeCoreRegister(0, r0);
        writeCoreRegister(1, r1);
        writeCoreRegister(2, r2);
        if (initialize) {
            writeCoreRegister(9, ALGO_STATIC_BASE);
            writeCoreRegister(13, ALGO_STACK);
        }
        writeCoreRegister(16, 0x01000000);
        writeCoreRegister(14, ALGO_LOAD_ADDRESS + 1);
        writeCoreRegister(20, 1);
        writeMemoryWord(DFSR, 3);
        writeMemoryWord(DHCSR, DHCSR_RUN);
        for (int retry = 0; retry < 30_000; retry++) {
            if ((readMemoryWord(DHCSR) & S_HALT) != 0) return readCoreRegister(0);
            sleep(1);
        }
        haltCore();
        throw new IOException("nRF54L15 flash algorithm timed out at 0x" + Integer.toHexString(pc));
    }

    private void writeDp(int address, int value) throws IOException { transfer(address, value); }
    private int readDp(int address) throws IOException { return transfer(address | READ, null); }
    private void writeAp(int request, int value) throws IOException { transfer(request, value); }

    private int readDpBlock(int address) throws IOException {
        ByteBuffer payload = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
        payload.put((byte) 0).putShort((short) 1).put((byte) (address | READ));
        byte[] response = transferBlock(payload.array(), 1);
        if (response.length < 8) throw new IOException("Short CMSIS-DAP DP read response");
        return ByteBuffer.wrap(response, 4, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
    }

    private int transfer(int request, Integer value) throws IOException {
        ByteBuffer payload = ByteBuffer.allocate(value == null ? 3 : 7).order(ByteOrder.LITTLE_ENDIAN);
        payload.put((byte) 0).put((byte) 1).put((byte) request);
        if (value != null) payload.putInt(value);
        boolean resetAttempted = false;
        for (int attempt = 0; attempt <= TRANSFER_RETRIES; attempt++) {
            byte[] response = command(DAP_TRANSFER, payload.array());
            if (response.length < 3 || (response[1] & 0xFF) != 1) {
                throw new IOException("Invalid CMSIS-DAP transfer response=" + hex(response));
            }
            int ack = response[2] & 7;
            if (ack == DAP_WAIT && attempt < TRANSFER_RETRIES) continue;
            if (ack == DAP_NO_ACK && !resetAttempted) {
                resetAttempted = true;
                swjSequence(repeat((byte) 0xFF, 7), 51);
                swjSequence(new byte[]{(byte) 0x9E, (byte) 0xE7}, 16);
                swjSequence(repeat((byte) 0xFF, 7), 51);
                swjSequence(new byte[]{0}, 8);
                continue;
            }
            if (ack != DAP_OK) {
                throw new IOException("CMSIS-DAP transfer failed response=" + hex(response));
            }
            if (value == null) {
                if (response.length < 7) throw new IOException("Short CMSIS-DAP read response");
                return ByteBuffer.wrap(response, 3, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            }
            return 0;
        }
        throw new IOException("CMSIS-DAP transfer retries exhausted");
    }

    private byte[] transferBlock(byte[] payload, int words) throws IOException {
        for (int attempt = 0; attempt <= TRANSFER_RETRIES; attempt++) {
            byte[] response = command(DAP_TRANSFER_BLOCK, payload);
            if (response.length < 4
                    || Short.toUnsignedInt(ByteBuffer.wrap(response, 1, 2)
                    .order(ByteOrder.LITTLE_ENDIAN).getShort()) != words) {
                throw new IOException("Invalid CMSIS-DAP block response=" + hex(response));
            }
            int ack = response[3] & 7;
            if (ack == DAP_WAIT && attempt < TRANSFER_RETRIES) continue;
            if (ack != DAP_OK) {
                throw new IOException("CMSIS-DAP block transfer failed response=" + hex(response));
            }
            return response;
        }
        throw new IOException("CMSIS-DAP block transfer retries exhausted");
    }

    private void swjSequence(byte[] sequence, int bits) throws IOException {
        byte[] payload = new byte[1 + sequence.length];
        payload[0] = (byte) bits;
        System.arraycopy(sequence, 0, payload, 1, sequence.length);
        statusCommand(DAP_SWJ_SEQUENCE, payload);
    }

    private void statusCommand(int command, byte[] payload) throws IOException {
        byte[] response = command(command, payload);
        if (response.length < 2 || response[1] != 0) {
            throw new IOException("CMSIS-DAP command 0x" + Integer.toHexString(command) + " failed");
        }
    }

    private byte[] command(int command, byte[] payload) throws IOException {
        if (payload.length + 1 > packetSize) throw new IOException("CMSIS-DAP command exceeds packet size");
        byte[] request = new byte[payload.length + 1];
        request[0] = (byte) command;
        System.arraycopy(payload, 0, request, 1, payload.length);
        IOException failure = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            int written = connection.bulkTransfer(output, request, request.length, USB_TIMEOUT_MS);
            if (written == request.length
                    && request.length < packetSize
                    && output.getMaxPacketSize() > 0
                    && request.length % output.getMaxPacketSize() == 0) {
                connection.bulkTransfer(output, new byte[0], 0, USB_TIMEOUT_MS);
            }
            if (written == request.length) {
                byte[] response = new byte[packetSize];
                int read = connection.bulkTransfer(input, response, response.length, USB_TIMEOUT_MS);
                if (read >= 1 && (response[0] & 0xFF) == command) {
                    byte[] exact = new byte[read];
                    System.arraycopy(response, 0, exact, 0, read);
                    return exact;
                }
                failure = new IOException(read < 1
                        ? "CMSIS-DAP USB read failed: " + read
                        : "Unexpected CMSIS-DAP response command");
            } else {
                failure = new IOException("CMSIS-DAP USB write failed: " + written);
            }
            clearEndpointHalt(output);
            clearEndpointHalt(input);
            if (attempt < 3) sleep(50L * (attempt + 1));
        }
        throw failure == null ? new IOException("CMSIS-DAP command failed") : failure;
    }

    private void clearEndpointHalt(UsbEndpoint endpoint) {
        // USB standard CLEAR_FEATURE(ENDPOINT_HALT), recipient = endpoint.
        connection.controlTransfer(0x02, 0x01, 0, endpoint.getAddress(), null, 0, USB_TIMEOUT_MS);
    }

    @Override public void close() {
        try { command(DAP_DISCONNECT, new byte[0]); } catch (IOException ignored) { }
        connection.releaseInterface(dapInterface);
        connection.close();
    }

    private static List<Segment> parseIHex(File file) throws IOException {
        List<Segment> segments = new ArrayList<>();
        int upper = 0;
        Segment current = null;
        try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                if (!line.startsWith(":")) throw new IOException("Invalid Intel HEX record");
                byte[] record = decodeHex(line.substring(1));
                if (record.length < 5 || checksum(record) != 0) throw new IOException("Invalid Intel HEX checksum");
                int length = record[0] & 0xFF;
                if (record.length != length + 5) throw new IOException("Invalid Intel HEX length");
                int address = ((record[1] & 0xFF) << 8) | (record[2] & 0xFF);
                int type = record[3] & 0xFF;
                if (type == 0) {
                    int absolute = upper + address;
                    byte[] data = new byte[length];
                    System.arraycopy(record, 4, data, 0, length);
                    if (current != null && current.address + current.data.length == absolute) {
                        byte[] joined = new byte[current.data.length + data.length];
                        System.arraycopy(current.data, 0, joined, 0, current.data.length);
                        System.arraycopy(data, 0, joined, current.data.length, data.length);
                        current.data = joined;
                    } else {
                        current = new Segment(absolute, data);
                        segments.add(current);
                    }
                } else if (type == 2 && length == 2) {
                    upper = (((record[4] & 0xFF) << 8) | (record[5] & 0xFF)) << 4;
                } else if (type == 4 && length == 2) {
                    upper = (((record[4] & 0xFF) << 8) | (record[5] & 0xFF)) << 16;
                } else if (type == 1) {
                    break;
                } else if (type != 3 && type != 5) {
                    throw new IOException("Unsupported Intel HEX record type " + type);
                }
            }
        }
        if (segments.isEmpty()) throw new IOException("Intel HEX image contains no data");
        return segments;
    }

    private static final class Segment {
        final int address;
        byte[] data;
        Segment(int address, byte[] data) { this.address = address; this.data = data; }
    }

    private static byte[] decodeHex(String value) throws IOException {
        if ((value.length() & 1) != 0) throw new IOException("Invalid Intel HEX encoding");
        byte[] result = new byte[value.length() / 2];
        for (int index = 0; index < result.length; index++) {
            int high = Character.digit(value.charAt(index * 2), 16);
            int low = Character.digit(value.charAt(index * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IOException("Invalid Intel HEX encoding");
            result[index] = (byte) ((high << 4) | low);
        }
        return result;
    }

    private static int checksum(byte[] record) {
        int value = 0;
        for (byte item : record) value = (value + (item & 0xFF)) & 0xFF;
        return value;
    }

    private static byte[] le32(int value) {
        return ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array();
    }

    private static byte[] repeat(byte value, int count) {
        byte[] result = new byte[count];
        java.util.Arrays.fill(result, value);
        return result;
    }

    private static int percent(long completed, long total) {
        return total == 0 ? 100 : (int) Math.min(100, completed * 100 / total);
    }

    private static void sleep(long milliseconds) throws IOException {
        try {
            Thread.sleep(milliseconds);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("CMSIS-DAP programming was interrupted", interrupted);
        }
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < Math.min(value.length, 16); index++) {
            result.append(String.format("%02x", value[index] & 0xFF));
        }
        return result.toString();
    }
}

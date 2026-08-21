/**
 * Hermes in react-native-macos 0.81 provides TextEncoder but not TextDecoder.
 * The SDK uses UTF-8 for mesh messages, so provide the missing web API before
 * importing the application.
 */
if (typeof globalThis.TextDecoder === 'undefined') {
  class Utf8TextDecoder {
    encoding = 'utf-8';
    fatal;
    ignoreBOM;

    constructor(label = 'utf-8', options = {}) {
      const normalizedLabel = String(label).trim().toLowerCase();
      if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(normalizedLabel)) {
        throw new RangeError(`Unsupported encoding: ${label}`);
      }

      this.fatal = Boolean(options.fatal);
      this.ignoreBOM = Boolean(options.ignoreBOM);
    }

    decode(input = new Uint8Array()) {
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);
      const codePoints = [];

      const invalid = () => {
        if (this.fatal) {
          throw new TypeError('The encoded data is not valid UTF-8');
        }
        codePoints.push(0xfffd);
      };

      for (let index = 0; index < bytes.length; ) {
        const first = bytes[index++];
        if (first < 0x80) {
          codePoints.push(first);
          continue;
        }

        let value;
        let continuationCount;
        let minimum;
        if (first >= 0xc2 && first <= 0xdf) {
          value = first & 0x1f;
          continuationCount = 1;
          minimum = 0x80;
        } else if (first >= 0xe0 && first <= 0xef) {
          value = first & 0x0f;
          continuationCount = 2;
          minimum = 0x800;
        } else if (first >= 0xf0 && first <= 0xf4) {
          value = first & 0x07;
          continuationCount = 3;
          minimum = 0x10000;
        } else {
          invalid();
          continue;
        }

        if (index + continuationCount > bytes.length) {
          invalid();
          break;
        }

        let valid = true;
        for (let offset = 0; offset < continuationCount; offset += 1) {
          const next = bytes[index + offset];
          if ((next & 0xc0) !== 0x80) {
            valid = false;
            break;
          }
          value = (value << 6) | (next & 0x3f);
        }

        if (!valid) {
          invalid();
          continue;
        }

        index += continuationCount;
        if (
          value < minimum ||
          value > 0x10ffff ||
          (value >= 0xd800 && value <= 0xdfff)
        ) {
          invalid();
          continue;
        }
        codePoints.push(value);
      }

      if (!this.ignoreBOM && codePoints[0] === 0xfeff) {
        codePoints.shift();
      }

      let result = '';
      for (let index = 0; index < codePoints.length; index += 0x1000) {
        result += String.fromCodePoint(...codePoints.slice(index, index + 0x1000));
      }
      return result;
    }
  }

  globalThis.TextDecoder = Utf8TextDecoder;
}

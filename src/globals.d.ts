declare class TextEncoder {
  encode(value?: string): Uint8Array;
}
declare class TextDecoder {
  decode(value?: Uint8Array): string;
}
declare function atob(value: string): string;
declare function btoa(value: string): string;

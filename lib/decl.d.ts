/**
 * pdf-parse 無官方型別，此處宣告最小介面。
 */
declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export = pdfParse;
}

/** xlsx 0.18.5 內建型別不足處（sheet_to_json 的 defval 等）以 any 通過，不做額外宣告。 */

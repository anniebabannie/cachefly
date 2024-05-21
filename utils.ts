import { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http";
import fetch from "node-fetch";
import sharp, { FormatEnum } from "sharp";

export function intOrUndefined(raw: string | null | undefined): number | undefined {
  if(typeof raw === "string"){
    const v = parseInt(raw);
    if(isNaN(v)) return undefined;
    return v;
  }
  return undefined;
}

export function headerOrDefault(req: IncomingMessage, name: string, defaultVal : string): string {
  const val = req.headers[name.toLowerCase()]
  if (val) {
    return val as string
  }
  return defaultVal
}

export function optimizeImage(arrayBuffer: ArrayBuffer, url: URL) {
  const img = sharp(arrayBuffer);
  if (url.searchParams.get("width") || url.searchParams.get("height")) {
    img.resize(
      intOrUndefined(url.searchParams.get("width")),
      intOrUndefined(url.searchParams.get("height")),
    )
  }
  if (url.searchParams.get("quality") || url.searchParams.get("format")) {
    const quality = url.searchParams.get("quality") as string;
    const format = url.searchParams.get("format");
    img.toFormat(
      format as keyof FormatEnum,
      { quality: parseInt(quality) }
    )
  }
  return img;
}

export const workerJob = function ({inBuf, startTime, bufferTime, originResp, url, resp, req, cb}: {
  inBuf: ArrayBuffer,
  startTime: number,
  bufferTime: number,
  originResp: fetch.Response,
  url: URL,
  resp: ServerResponse,
  req: IncomingMessage,
  cb: Function
}) {
  const queueTime = new Date().getTime() - startTime - bufferTime;

  const img = optimizeImage(inBuf, url);

  const contentTypeHeader = url.searchParams.get("format") !== originResp.headers.get("content-type") ? `image/${url.searchParams.get("format")}` : originResp.headers.get("content-type") || ""
  const responseHeaders: OutgoingHttpHeaders = {}

  img.toBuffer((err, buf) => {
    if(resp.writableEnded){
      // wat
      console.error('write already happened:', url)
      cb();
      return;
    }
    if (err){
      console.error("error:", err.message);
      resp.writeHead(500)
      //@ts-ignore
      resp.end(`error processing image: #{url}`);
      cb();
      return;
    }

    //@ts-ignore
    if(req.socket.requestCount > 4){
      responseHeaders.connection = "close";
    }
    const headers = {
      "timing-allow-origin": "*",
      "content-type": contentTypeHeader,
      "content-length": buf.length,
      "etag": originResp.headers.get("etag"),
      "last-modified": originResp.headers.get("last-modified"),
      "x-origin-ms": bufferTime,
      "x-queue-ms": queueTime,
      "x-process-ms": new Date().getTime() - startTime - bufferTime - queueTime,
      ...responseHeaders
    } as OutgoingHttpHeaders;

    resp.writeHead(200, headers);
    resp.end(buf);
    cb();
  })
};
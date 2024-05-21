import { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http";
import fetch from "node-fetch";
import sharp, { FormatEnum } from "sharp";
import Tigris from "./tigris";

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

export function getCachedFilename(url: URL): string {
  let width, height, quality: number | undefined;
  let format: keyof FormatEnum | undefined;

  let originFilename = url.pathname.split("/").pop() as string;
  let name = originFilename.split(".")[0];
  let ext = originFilename.split(".")[1];
  let filename = `${name}.${ext}`;

  width = intOrUndefined(url.searchParams.get("width"));
  height = intOrUndefined(url.searchParams.get("height"));
  quality = parseInt(url.searchParams.get("quality") as string);
  format = url.searchParams.get("format") as keyof FormatEnum;

  if (!format || format === ext) {
    format = ext as keyof FormatEnum;
    filename = `${name}.${format}`;
  } else {
    filename = `${name}.${format}`;
  }

  if (width) filename = `w${width}-${filename}`;
  if (height) filename = `h${height}-${filename}`;
  if (quality) filename = `q${quality}-${filename}`;

  return filename;
}

export function optimizeImage(arrayBuffer: ArrayBuffer, url: URL): {img: sharp.Sharp, filename: string } {
  const img = sharp(arrayBuffer);
  let width, height, quality: number | undefined;
  let format: keyof FormatEnum | undefined;
  let originFilename = url.pathname.split("/").pop() as string;
  let ext = originFilename.split(".")[1];

  if (url.searchParams.get("width") || url.searchParams.get("height")) {
    width = intOrUndefined(url.searchParams.get("width"));
    height = intOrUndefined(url.searchParams.get("height"));
    
    img.resize(width,height)
  }
  if (url.searchParams.get("quality") || url.searchParams.get("format")) {
    quality = parseInt(url.searchParams.get("quality") as string);
    format = url.searchParams.get("format") as keyof FormatEnum;

    if (!format || format === ext) format = ext as keyof FormatEnum;
    
    img.toFormat(format, { quality })
  }
  const filename = getCachedFilename(url);
  return {img, filename};
}

export const workerJob = async function ({inBuf, startTime, bufferTime, originResp, url, resp, req, cb}: {
  inBuf: ArrayBuffer,
  startTime: number,
  bufferTime: number,
  originResp: fetch.Response,
  url: URL,
  resp: ServerResponse,
  req: IncomingMessage,
  cb: Function
}) {
  console.log("WORKING STUFF......")
  const queueTime = new Date().getTime() - startTime - bufferTime;

  const {img, filename} = optimizeImage(inBuf, url);

  // const contentTypeHeader = url.searchParams.get("format") !== originResp.headers.get("content-type") ? `image/${url.searchParams.get("format")}` : originResp.headers.get("content-type") || ""
  let contentType = originResp.headers.get("content-type") || "";
  if (url.searchParams.get("format")) {
    contentType = url.searchParams.get("format") !== originResp.headers.get("content-type") ? `image/${url.searchParams.get("format")}` : originResp.headers.get("content-type") || ""
  }
  const responseHeaders: OutgoingHttpHeaders = {}
  
  img.toBuffer((err, buf) => {

    Tigris.putObject({
      Body: buf,
      Bucket: process.env.BUCKET_NAME,
      Key: `cache/${filename}`,
    })

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
    if(req.socket.requestCount > 4) {
      responseHeaders.connection = "close";
    }
    const headers = {
      "timing-allow-origin": "*",
      "content-type": contentType,
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
import http from 'http';
import gm from 'gm';
import { createHash } from 'crypto';
import queue, { QueueWorker } from "queue";
import fetch, { Response } from "node-fetch";

function md5(input:string){
  return createHash('md5').update(input).digest("hex");
}
/*
var crypto = require('crypto');
crypto.createHash('md5').update(data).digest("hex");
*/

const agent = new http.Agent({
  keepAlive: true
});

const q = queue({autostart: true, concurrency: 4, timeout: 20000})
let processedCount = 0

// get notified when jobs complete
q.on('success', function (result, job) {
  processedCount += 1
})

// job timed out
q.on('timeout', function (next, job) {
  const url: string | undefined = job.url as string;

  if(job.url){
    console.error('job timed out:', url.toString());
  }else{
    console.error('job timed out: <unknown>')
  }
  if(job.resp){
    const resp = job.resp as http.ServerResponse;
    if(resp.writableEnded){
      resp.writeHead(504);
      resp.end("Image processing timed out");
    }
  }
  next()
});

q.start(function (err) {
  if (err) {
    console.error("error running queue:", err)
  }
  console.log('queue complete')
})

interface RequestOptions{
  url: URL,
  responseHeaders: http.OutgoingHttpHeaders
}
interface FilterFunction{
  (img: gm.State, value: any, opts: RequestOptions): void;
}

function intOrUndefined(raw: string | null | undefined): number | undefined{
  if(typeof raw === "string"){
    const v = parseInt(raw);
    if(isNaN(v)) return undefined;
    return v;
  }
  return undefined;
}



function fetchOrigial(url: URL): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    try {
      http.get(url, (response) => {
        resolve(response)
      })
    } catch (err) {
      reject(err)
    }
  })
}

const filters = new Map<string,FilterFunction> ([
  ["auto_fix", (img, value) => value === "true" ? img.out("-contrast-stretch","2%", "1%") : img],
  ["flip", (img, value) =>value === "true" ? img.flip() : img],
  ["sharp_radius", (img, value, {url}) => img.sharpen(
    intOrUndefined(url.searchParams.get("sharp_radius")) || 1,
    intOrUndefined(url.searchParams.get("sharp_amount"))
  )],
  ["width", (img, value, {url}) => img.resize(
    intOrUndefined(value),
    intOrUndefined(url.searchParams.get("height")),
    url.searchParams.get("crop") == "stretch" ? "!" : undefined
  )],
  ["quality", (img, value) => img.quality(intOrUndefined(value))],
  ["format", (img, value, {responseHeaders}) => {
    img.setFormat(value)
    responseHeaders['content-type'] = `image/${value}`;
  }]
]);

function headerOrDefault(req: http.IncomingMessage, name: string, defaultVal : string): string {
  const val = req.headers[name.toLowerCase()]
  if (val) {
    return val as string
  }
  return defaultVal
}

// fly deploy:image registry-1.docker.io/nginxdemos/hello:latest
const bootTime = new Date();
let lastQueueLength = 0;
let lastProcessedCount = 0
const server = http.createServer(async (req, resp) =>{
  //console.log([req.httpVersion, req.socket.remoteAddress, req.url, req.headers["user-agent"]].join(" "))

  if ((req.method === "HEAD" || req.method === "GET") && req.url === "/__status") {
    const now = new Date();
    console.debug(
      "imagemagick queue length:", q.length.toString(),
      "last queue length:", lastQueueLength.toString(),
      "processed count:", processedCount.toString(),
      "last processed count:", lastProcessedCount.toString(),
      "uptime:", ((now.getTime() - bootTime.getTime()) / 1000).toString(),
    );
    lastQueueLength = q.length;
    lastProcessedCount = processedCount
    resp.writeHead(200, { connection: "close"} );
    resp.end("ok: " + q.length)
    return
  }

  const responseHeaders: http.OutgoingHttpHeaders = {}
  const url = new URL(req.url, "http://magick");

  const originBase = headerOrDefault(req, "Image-Origin", "http://dealercarsearch-sf.static-ord.sctgos.com/");
  const origin = new URL(url.pathname.substr(1), originBase);
  const accept = headerOrDefault(req, "accept", "");
  if (url.search.length < 1) {
    url.search = headerOrDefault(req, "Image-Operation", "");
  }
  
  let startTime = new Date().getTime();
  let originResp: Response

  try {
     originResp = await fetch(origin.href, {timeout: 20000, agent: agent})
    // originResp = await fetchOrigial(origin)
    if (originResp.status != 200) {
      resp.statusCode = originResp.status
      originResp.body.pipe(resp)
      return
    }
  } catch (err) {
    console.error("origin error", err.message, url.toString());
    resp.statusCode = 503
    resp.end("Error fetching from origin")
    return
  }
  
  
  const contentType = originResp.headers.get("content-type") || ""

  if (!contentType.includes("image/")) {
    resp.statusCode = 400
    resp.end("unexpected content type: " + contentType)
    return
  }
  
  let fmt = url.searchParams.get("format")
  if (fmt === "auto") {
    if (accept.includes("/webp")) {
      url.searchParams.set("format", "webb");
    } else {
      url.searchParams.delete("format")
    }
  }

  if (url.search.length == 0) {
    originResp.headers.forEach((name, val) => {
      resp.setHeader(name, val)
    })
    resp.setHeader("timing-allow-origin", "*")
    originResp.body.pipe(resp)
    return
  }

  // original magick server that's now inside a queue for concurrency control...

  const inBuf = await originResp.buffer()

  const bufferTime = new Date().getTime() - startTime;

  const worker = function (cb) {
    const queueTime = new Date().getTime() - startTime - bufferTime;
    // const etag = [origin.href, url.search].map(md5).join("/");
    const img = gm(inBuf);

    //@ts-ignore
    img._options.imageMagick = true;

    url.searchParams.forEach((value, key) => {
      const filter = filters.get(key);
      if(filter){
        filter(img, value, {url, responseHeaders});
      }
    })

    //const img = gm(req).out("-contrast-stretch","2%", "1%");
    let dataIn = inBuf.length;
    let dataOut = 0;

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
      dataOut = buf.length;
      resp.writeHead(200, Object.assign({
        "timing-allow-origin": "*",
        "content-type": contentType,
        "content-length": buf.length,
        etag: originResp.headers.get("etag"),
        "last-modified": originResp.headers.get("last-modified"),
        "x-origin-ms": bufferTime,
        "x-queue-ms": queueTime,
        "x-process-ms": new Date().getTime() - startTime - bufferTime - queueTime,
        "x-original-size": dataIn, 
      }, responseHeaders));
      resp.end(buf);
      // req.socket.end();
      //console.log(`${origin}${url.search}, ${dataIn / 1024}kB input, ${dataOut / 1024}kB output, download:${bufferTime}ms, queue:${queueTime}ms, process:${new Date().getTime() - startTime - bufferTime - queueTime}ms, total:${new Date().getTime() - startTime}`);
      cb();
    })
  };

  q.push(Object.assign(worker, { resp, url }) as QueueWorker)
})
server.on("connection", (socket) => {
  //console.log([socket.remoteAddress, "TCP connection"].join(" "))
  // socket.setKeepAlive(false)
})
server.listen(8080);
console.log(`http server listening on port 8080`)
import http from 'http';
import queue, { QueueWorker } from "queue";
import fetch from "node-fetch";
import { getCachedFilename, headerOrDefault, workerJob } from './utils';

const agent = new http.Agent({
  keepAlive: true
});

const Queue = queue({autostart: true, concurrency: 4, timeout: 20000})
let processedCount = 0
let connectionCount = 0

// get notified when jobs complete
Queue.on('success', function (result, job) {
  processedCount += 1
})

// job timed out
Queue.on('timeout', function (next, job) {
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

Queue.start(function (err) {
  if (err) {
    console.error("error running queue:", err)
  }
  console.log('queue complete')
})

const bootTime = new Date();
let lastQueueLength = 0;
let lastProcessedCount = 0

const server = http.createServer(async (req, resp) =>{
  if (!req.url || req.url === "/favicon.ico") return;

  if ((req.method === "HEAD" || req.method === "GET") && req.url === "/__status") {
    const now = new Date();
    console.debug([
      "Image optimzation queue length: " + Queue.length.toString(),
      "last queue length: " + lastQueueLength.toString(),
      "processed: " + `${processedCount - lastProcessedCount}/${processedCount}`,
      "connections: " + connectionCount.toString(),
      "uptime: " + ((now.getTime() - bootTime.getTime()) / 1000).toString(),
    ].join(", ")
    );
    lastQueueLength = Queue.length;
    lastProcessedCount = processedCount
    resp.writeHead(200, { connection: "close"} );
    resp.end("ok: " + Queue.length)
    return
  }

  
  const url = new URL(`${process.env.AWS_ENDPOINT_URL_S3}/${process.env.BUCKET_NAME}${req.url}`);

  const accept = headerOrDefault(req, "accept", "");
  if (url.search.length < 1) {
    url.search = headerOrDefault(req, "Image-Operation", "");
  }
  
  let startTime = new Date().getTime();
  let originResp: fetch.Response;

  const cachedFilename = getCachedFilename(url);

  const cachedImg = await fetch(`${process.env.AWS_ENDPOINT_URL_S3}/${process.env.BUCKET_NAME}/${cachedFilename}`, {timeout: 20000, agent: agent});
  if (cachedImg.status === 200) {
    const extension = url.pathname.split(".").pop();
    console.log("serving cached image.......", url.href)
    resp.setHeader("content-type", `image/${extension}`);
    originResp = cachedImg;
    originResp.body.pipe(resp);
    return;
  }

  try {
    console.log("fetching image URL.......", url.href)
    originResp = await fetch(url.href, {timeout: 20000, agent: agent})
    if (originResp.status != 200) {
      console.log("origin status was NOT 200")
      resp.statusCode = originResp.status
      originResp.body.pipe(resp)
      return
    }
  } catch (err) {
    console.error("origin error", err, url.toString());
    resp.writeHead(503, { "connection": "keep-alive"});
    resp.end("Error fetching from origin");
    return
  }
  
  let contentType = originResp.headers.get("content-type") || ""

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

  // @ts-ignore
  req.socket.requestCount += 1;

  let inBuf: ArrayBuffer
  try {
    inBuf = await originResp.arrayBuffer()
  } catch (error) {
    console.log(originResp.status)
    console.error('error reading origin body:', error)
    resp.writeHead(504, { "connection": "keep-alive"});
    resp.end("Error fetching from origin");
    return
  }

  const bufferTime = new Date().getTime() - startTime;

  const worker = function (cb: Function) {
    workerJob({inBuf, startTime, bufferTime, originResp, url, resp, req, cb});
  };

  Queue.push(Object.assign(worker, { resp, url }) as QueueWorker)
})
server.on("connection", (socket) => {
  connectionCount += 1;
  Object.assign(socket, {requestCount: 0 })
})
server.listen(8080);
console.log(`http server listening on port 8080`)
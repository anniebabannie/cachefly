import http from 'http';
import gm from 'gm';
import { createHash } from 'crypto';

function md5(input:string){
  return createHash('md5').update(input).digest("hex");
}
/*
var crypto = require('crypto');
crypto.createHash('md5').update(data).digest("hex");
*/

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

const authToken = process.env.AUTH_TOKEN;
// fly deploy:image registry-1.docker.io/nginxdemos/hello:latest
const server = http.createServer(async (req, resp) =>{
  console.log([req.httpVersion, req.socket.remoteAddress, req.url, req.headers["user-agent"]].join(" "))

  if((req.method === "HEAD" || req.method === "GET") && req.url === "/__status"){
    resp.writeHead(200, { connection: "close"} );
    resp.end("ok")
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
  
  let originResp: http.IncomingMessage

  try {
    originResp = await fetchOrigial(origin)
    if (originResp.statusCode != 200) {
      resp.statusCode = originResp.statusCode
      originResp.pipe(resp)
      return
    }
  } catch (err) {
    console.error("origin error", err)
    resp.statusCode = 500
    resp.end("Error fetching from origin")
    return
  }
  
  const contentType = headerOrDefault(originResp, "content-type", "")

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
    for (const [name, val] of Object.entries(originResp.headers)) {
      resp.setHeader(name, val)
    }
    resp.setHeader("timing-allow-origin", "*")
    originResp.pipe(resp)
    return
  }

  // original magick server...

  // const etag = [origin.href, url.search].map(md5).join("/");
  const img = gm(originResp);
  //@ts-ignore
  img._options.imageMagick = true;

  url.searchParams.forEach((value, key) => {
    const filter = filters.get(key);
    if(filter){
      filter(img, value, {url, responseHeaders});
    }
  })

  //const img = gm(req).out("-contrast-stretch","2%", "1%");
  let dataIn = 0;
  let dataOut = 0;
  let startTime = new Date().getTime();
  originResp.on('data', (chunk) => {
    dataIn += chunk.length
  });

  img.toBuffer((err, buf) => {
    if (err){
      console.trace("error:", err.message);
      resp.writeHead(500)
      //@ts-ignore
      resp.end("error processing image");
      return;
    }
    dataOut = buf.length;
    resp.writeHead(200, Object.assign({
      "timing-allow-origin": "*",
      "content-type": contentType,
      "content-length": buf.length,
      etag: originResp.headers['etag'],
      "last-modified": originResp.headers["last-modified"],
    }, responseHeaders));
    resp.end(buf);
    req.socket.end();
    console.log(`${origin}${url.search}, ${dataIn / 1024}kB input, ${dataOut / 1024}kB output, ${new Date().getTime() - startTime}ms`);
  })
})
server.on("connection", (socket) => {
  console.log([socket.remoteAddress, "TCP connection"].join(" "))
  socket.setKeepAlive(false)
})
server.listen(8080);
console.log(`http server listening on port 8080`)
console.log(`Auth token: ${authToken}`)
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
const filters = new Map<string,FilterFunction> ([
  ["auto_fix", (img, value) => value === "true" ? img.out("-contrast-stretch","2%", "1%") : img],
  ["flip", (img, value) =>value === "true" ? img.flip() : img],
  ["sharp_radius", (img, value, {url}) => img.sharpen(
    intOrUndefined(url.searchParams.get("sharp_radius")) || 1,
    intOrUndefined(url.searchParams.get("sharp_amount"))
  )],
  ["width", (img, value, {url}) => img.resize(
    intOrUndefined(value),
    intOrUndefined(url.searchParams.get("height"))
  )],
  ["quality", (img, value) => img.quality(intOrUndefined(value))],
  ["format", (img, value, {responseHeaders}) => {
    img.setFormat(value)
    responseHeaders['content-type'] = `image/${value}`;
  }]
]);

const authToken = process.env.AUTH_TOKEN;
// fly deploy:image registry-1.docker.io/nginxdemos/hello:latest
const server = http.createServer((req, resp) =>{
  console.log([req.httpVersion, req.socket.remoteAddress, req.url, req.headers["user-agent"]].join(" "))

  if((req.method === "HEAD" || req.method === "GET") && req.url === "/__status"){
    resp.writeHead(200, { connection: "close"} );
    resp.end("ok")
    return
  }
  if(authToken){
    const auth = req.headers['authorization'] || "";
    if(auth !== `Bearer ${authToken}`){
      console.error("auth token mismatch:", auth)
      resp.writeHead(403);
      resp.end("no yuo")
      return;
    }
  }
  const responseHeaders: http.OutgoingHttpHeaders = {}
  const url = new URL(req.url, "http://magick");
  if(req.method !== "POST"){
    resp.writeHead(405);
    resp.end("")
    return;
  }
  const origin = url.searchParams.get("origin") || url.pathname;
  url.searchParams.delete("origin");

  const etag = [origin, url.search].map(md5).join("/");
  const img = gm(req);
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
  req.on('data', (chunk) => {
    dataIn += chunk.length
  });

  img.toBuffer((err, buf) => {
    if(err){
      console.trace("error:", err.message);
      resp.writeHead(500)
      //@ts-ignore
      resp.end(err.toString());
      return;
    }
    dataOut = buf.length;
    resp.writeHead(200,Object.assign({
      "content-type": req.headers["content-type"],
      "content-length": buf.length,
      etag: etag
    }, responseHeaders));
    resp.end(buf);
    console.log(`${origin}${url.search}, ${dataIn / 1024}kB input, ${dataOut / 1024}kB output, ${new Date().getTime() - startTime}ms`);
  })
})
server.on("connection", (socket) => {
  console.log([socket.remoteAddress, "TCP connection"].join(" "))
})
server.listen(8080);
console.log(`http server listening on port 8080`)
console.log(`Auth token: ${authToken}`)
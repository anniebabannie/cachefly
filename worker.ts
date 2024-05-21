import { filters }  from './index';

const worker = function ({ callback, startTime, bufferTime, url, responseHeaders, originResp, inBuf, resp, req, gm, contentType }:{
  callback: Function,
  startTime: number,
  bufferTime: number,
  url: URL,
  responseHeaders: any,
  originResp: any,
  inBuf: Buffer,
  resp: any,
  req: any,
  gm: any,
  contentType: string
}) {
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
      callback();
      return;
    }
    if (err){
      console.error("error:", err.message);
      resp.writeHead(500)
      //@ts-ignore
      resp.end(`error processing image: #{url}`);
      callback();
      return;
    }
    dataOut = buf.length;

    //@ts-ignore
    if(req.socket.requestCount > 4){
      responseHeaders.connection = "close";
    }
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
    callback();
  })
};

export default worker;
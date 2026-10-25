import fs from "node:fs"; import { PNG } from "pngjs";
const dem = PNG.sync.read(fs.readFileSync("assets/dem.png"));
const popImg = PNG.sync.read(fs.readFileSync("assets/pop.png")); const W=dem.width,H=dem.height,N=W*H;
const { instance } = await WebAssembly.instantiate(fs.readFileSync("build/flood.wasm"), { env:{ abort(){throw new Error("abort")} } });
const k = instance.exports; k.setup(W,H); const mem=()=>k.memory.buffer;
const elev=new Float32Array(mem(),k.elevPtr(),N), cls=new Uint8Array(mem(),k.clsPtr(),N), row=new Float64Array(mem(),k.rowAreaPtr(),H);
const pop=new Float32Array(mem(),k.popPtr(),N), cty=new Uint8Array(mem(),k.countryPtr(),N);
for(let i=0;i<N;i++){const e=dem.data[i*4]*256+dem.data[i*4+1]; elev[i]=e/65535*9500-500; cls[i]=dem.data[i*4+2]; pop[i]=Math.expm1((popImg.data[i*4]*256+popImg.data[i*4+1])/65535*Math.log1p(5e7)); cty[i]=popImg.data[i*4+2];}
for(let y=0;y<H;y++){const lat=90-(y+.5)/H*180; row[y]=(180/H*111.32)*(360/W*111.32*Math.cos(lat*Math.PI/180));}
let t=performance.now(); const n=k.priorityFlood(); console.log("priorityFlood", n, "cells", (performance.now()-t).toFixed(0),"ms");
const spill=new Float32Array(mem(),k.spillPtr(),N);
const at=(la,lo)=>{const x=Math.floor((lo+180)/360*W),y=Math.floor((90-la)/180*H),i=y*W+x;return {elev:+elev[i].toFixed(1),spill:+spill[i].toFixed(1),cls:cls[i]}};
for (const [n,la,lo] of [["Amsterdam",52.37,4.9],["Dhaka",23.7,90.4],["Caspian",41.7,50.8],["Caspian shore",46.5,49],["Denver",39.7,-105],["Death Valley",36.5,-117],["Qattara",29.8,27.1]]) console.log(n, at(la,lo));
let landA=0; for(let y=0;y<H;y++){let c=0;for(let x=0;x<W;x++) if(cls[y*W+x]==255)c++; landA+=c*row[y];}
const out=new Float64Array(mem(),k.outPtr(),32);
for (const s of [1,2,7,66]) { t=performance.now(); k.floodStats(s); const a=out[0], p=out[1]; console.log(`+${s}m flooded ${Math.round(a).toLocaleString()} km2 (${(a/landA*100).toFixed(2)}%), ${(p/1e6).toFixed(0)} M people in flooded cells, ${(performance.now()-t).toFixed(1)}ms`); }
let ptot=0; for(let i=0;i<N;i++) ptot+=pop[i]; console.log("population surface", (ptot/1e9).toFixed(2), "B");
console.log("land area", Math.round(landA).toLocaleString());

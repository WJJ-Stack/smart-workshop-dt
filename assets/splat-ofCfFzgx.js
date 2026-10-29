import{Dt as e,Fn as t,Pn as n,a as r,d as i,dn as a,fn as o,gn as s,gt as c,ht as l,m as u,p as d,pn as ee,pt as f,v as p}from"./bvh-BYwfhFTF.js";import{l as m}from"./three-vBysp37d.js";function h(e){let t=Math.floor(e.byteLength/32),n=new Float32Array(t*3),r=new Float32Array(t*3),i=new Float32Array(t*3),a=new Float32Array(t),o=new Float32Array(t*4),s=new DataView(e);for(let e=0;e<t;e+=1){let t=e*32,c=e*12,l=e*4,u=s.getFloat32(t,!0),d=s.getFloat32(t+4,!0),ee=s.getFloat32(t+8,!0);n[c]=u,n[c+1]=ee,n[c+2]=-d,r[c]=s.getFloat32(t+12,!0),r[c+1]=s.getFloat32(t+16,!0),r[c+2]=s.getFloat32(t+20,!0),i[c]=s.getUint8(t+24)/255,i[c+1]=s.getUint8(t+25)/255,i[c+2]=s.getUint8(t+26)/255,a[e]=s.getUint8(t+27)/255;let f=(s.getUint8(t+28)-128)/128,p=(s.getUint8(t+29)-128)/128,m=(s.getUint8(t+30)-128)/128,h=(s.getUint8(t+31)-128)/128;o[l]=f,o[l+1]=m,o[l+2]=-p,o[l+3]=h}return{count:t,positions:n,scales:r,colors:i,alphas:a,quats:o}}var te=`
precision highp float;

attribute vec2 aCorner;       // quad corner (-1..1)
attribute vec3 aPosition;
attribute vec3 aScale;
attribute vec3 aColor;
attribute float aAlpha;
attribute vec4 aQuat;

uniform vec2 uViewport;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uFocal;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vQuad;

mat3 quatToMat(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  float x2 = x + x, y2 = y + y, z2 = z + z;
  float xx = x * x2, xy = x * y2, xz = x * z2;
  float yy = y * y2, yz = y * z2, zz = z * z2;
  float wx = w * x2, wy = w * y2, wz = w * z2;
  return mat3(
    1.0 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1.0 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1.0 - (xx + yy)
  );
}

void main() {
  vQuad = aCorner;

  vec4 camPos = uView * vec4(aPosition, 1.0);
  float depth = -camPos.z;   // 相机看向 -Z，取正值

  // 近裁剪面外的高斯直接丢弃（推到屏幕外）
  if (depth < 0.15) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }

  // --- 1. 世界空间 3D 协方差 Σ = R S Sᵀ Rᵀ
  mat3 R = quatToMat(normalize(aQuat));
  mat3 M = R * mat3(
    aScale.x, 0.0, 0.0,
    0.0, aScale.y, 0.0,
    0.0, 0.0, aScale.z
  );
  mat3 SigmaW = M * transpose(M);

  // --- 2. 把协方差转到相机空间（关键：Σ 是世界空间的，必须先做 V Σ Vᵀ）
  mat3 V = mat3(uView);
  mat3 SigmaC = V * SigmaW * transpose(V);

  // --- 3. 相机空间透视雅可比
  //     px = f·x/d, py = f·y/d, d = -z
  //     ∂px/∂z = f·x/d²,  ∂py/∂z = f·y/d²
  float f = uFocal;
  float invD = 1.0 / depth;
  float invD2 = invD * invD;
  mat3 J = mat3(
    f * invD, 0.0,     f * camPos.x * invD2,
    0.0,     f * invD, f * camPos.y * invD2,
    0.0,     0.0,      0.0
  );

  // --- 4. 屏幕空间 2D 协方差（像素²）
  mat3 T = J * SigmaC * transpose(J);
  float a = T[0][0] + 0.3;
  float b = T[0][1];
  float c = T[1][1] + 0.3;

  // --- 5. 特征值分解求椭圆半轴
  float mid = 0.5 * (a + c);
  float disc = max(0.0, mid * mid - (a * c - b * b));
  float root = sqrt(disc);
  float l1 = mid + root;
  float l2 = max(0.0, mid - root);

  vec2 axis1 = normalize(vec2(b, l1 - a) + vec2(1e-9, 1e-9));
  vec2 axis2 = vec2(-axis1.y, axis1.x);

  float r1 = 2.6 * sqrt(l1);
  float r2 = 2.6 * sqrt(l2);

  // --- 6. 中心 NDC 与像素偏移
  vec4 clip = uProj * camPos;
  float w = max(1e-5, clip.w);
  vec2 ndc = clip.xy / w;

  vec2 offset =
    axis1 * aCorner.x * r1 * (2.0 / uViewport.x) +
    axis2 * aCorner.y * r2 * (2.0 / uViewport.y);

  gl_Position = vec4(ndc + offset, clip.z / w, 1.0);

  vColor = aColor;
  vAlpha = aAlpha;
}
`,ne=`
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vQuad;

void main() {
  // 单位圆内的高斯衰减
  float r2 = dot(vQuad, vQuad);
  if (r2 > 1.0) discard;
  float falloff = exp(-3.0 * r2);
  float alpha = vAlpha * falloff;
  if (alpha <= 0.004) discard;

  // 预乘 alpha 输出，配合 blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
  gl_FragColor = vec4(vColor * alpha, alpha);
}
`;async function g(g,_,v){let y=new r({canvas:g,antialias:!1,alpha:!1});y.setPixelRatio(Math.min(window.devicePixelRatio,2)),y.setSize(g.clientWidth,g.clientHeight,!1),y.outputColorSpace=a;let b=new o;b.background=new p(329741);let x=new e(50,g.clientWidth/Math.max(1,g.clientHeight),.5,2e3);x.position.set(24,16,28);let S=new m(x,g);S.enableDamping=!0,S.dampingFactor=.08,S.target.set(0,1.6,0),S.minDistance=1.5,S.maxDistance=160,v(.08,`下载 .splat…`);let C=await fetch(_);if(!C.ok)throw Error(`加载失败 HTTP ${C.status}（${_}）`);let w=Number(C.headers.get(`content-length`)??0),T=C.body?.getReader(),E=[],D=0;if(T)for(;;){let{done:e,value:t}=await T.read();if(e)break;t&&(E.push(t),D+=t.byteLength,w>0&&v(.08+D/w*.55,`${(D/1048576).toFixed(1)} MB`))}let O=new Uint8Array(D),k=0;for(let e of E)O.set(e,k),k+=e.byteLength;v(.68,`解析高斯数据…`);let A=h(O.buffer);if(A.count===0)throw Error(`.splat 文件为空或格式不正确`);v(.8,`构建 ${A.count.toLocaleString()} 个高斯…`);let j=A.count*6,re=new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]),M=new Float32Array(j*2),N=new Float32Array(j*3),P=new Float32Array(j*3),F=new Float32Array(j*3),I=new Float32Array(j),L=new Float32Array(j*4);for(let e=0;e<A.count;e+=1){let t=e*3,n=e*4;for(let r=0;r<6;r+=1){let i=e*6+r,a=i*2,o=i*3,s=i*4;M[a]=re[r*2],M[a+1]=re[r*2+1],N[o]=A.positions[t],N[o+1]=A.positions[t+1],N[o+2]=A.positions[t+2],P[o]=A.scales[t],P[o+1]=A.scales[t+1],P[o+2]=A.scales[t+2],F[o]=A.colors[t],F[o+1]=A.colors[t+1],F[o+2]=A.colors[t+2],I[i]=A.alphas[e],L[s]=A.quats[n],L[s+1]=A.quats[n+1],L[s+2]=A.quats[n+2],L[s+3]=A.quats[n+3]}}let R=new u;R.setAttribute(`position`,new d(new Float32Array(j*3),3)),R.setAttribute(`aCorner`,new d(M,2)),R.setAttribute(`aPosition`,new d(N,3)),R.setAttribute(`aScale`,new d(P,3)),R.setAttribute(`aColor`,new d(F,3)),R.setAttribute(`aAlpha`,new d(I,1)),R.setAttribute(`aQuat`,new d(L,4)),R.boundingSphere=new s(new t(0,4,0),200),R.boundingBox=new i(new t(-100,-20,-100),new t(100,30,100));let z={uViewport:{value:new n(g.clientWidth,g.clientHeight)},uView:{value:new l},uProj:{value:new l},uFocal:{value:800}},B=new ee({vertexShader:te,fragmentShader:ne,uniforms:z,transparent:!1,depthWrite:!1,depthTest:!0,blending:5,blendSrc:201,blendDst:205,blendEquation:100,side:2}),V=new c(R,B);V.frustumCulled=!1,V.renderOrder=0,b.add(V);{let e=y.getContext();y.info.autoReset=!1,y.info.reset(),y.render(b,x);let t=e.getError();console.info(`[splat] 首次渲染 glError=${t} calls=${y.info.render.calls}`),window.__splatDraw=()=>(y.info.reset(),y.render(b,x),{vertices:R.getAttribute(`aPosition`).count,drawCalls:y.info.render.calls,triangles:y.info.render.triangles,glError:e.getError(),visible:V.visible,inScene:!!V.parent,camPos:x.position.toArray().map(e=>Math.round(e)),target:S.target.toArray().map(e=>Math.round(e))})}{let e=1/0,t=1/0,n=1/0,r=-1/0,i=-1/0,a=-1/0;for(let o=0;o<A.count;o+=1){let s=A.positions[o*3],c=A.positions[o*3+1],l=A.positions[o*3+2];s<e&&(e=s),c<t&&(t=c),l<n&&(n=l),s>r&&(r=s),c>i&&(i=c),l>a&&(a=l)}console.info(`[splat] 数据范围 X[${e.toFixed(1)}, ${r.toFixed(1)}] Y[${t.toFixed(1)}, ${i.toFixed(1)}] Z[${n.toFixed(1)}, ${a.toFixed(1)}]`);let o=(e+r)*.5,s=(t+i)*.5,c=(n+a)*.5,l=Math.max(r-e,i-t,a-n);x.position.set(o+l*.85,s+l*.7,c+l*1),S.target.set(o,s,c),S.minDistance=l*.05,S.maxDistance=l*6,S.update(),x.updateMatrixWorld(!0),window.__splatDebug=()=>({count:A.count,bounds:{min:[e,t,n],max:[r,i,a]},camera:x.position.toArray(),target:[o,s,c],span:l})}let H=new Uint32Array(A.count*6);for(let e=0;e<A.count;e+=1){let t=e*6;H[t]=t,H[t+1]=t+1,H[t+2]=t+2,H[t+3]=t+3,H[t+4]=t+4,H[t+5]=t+5}let U=new d(H,1);R.setIndex(U);let W=new Float32Array(A.count),G=new Uint32Array(A.count);for(let e=0;e<A.count;e+=1)G[e]=e;let K=!0,q=0,J=0,Y=x.position.clone(),X=0,Z=0,Q=0,ie=()=>{let e=performance.now(),t=x.position;for(let e=0;e<A.count;e+=1){let n=e*3,r=A.positions[n]-t.x,i=A.positions[n+1]-t.y,a=A.positions[n+2]-t.z;W[e]=r*r+i*i+a*a}let n=Array.from(G);n.sort((e,t)=>W[t]-W[e]);for(let e=0;e<A.count;e+=1){let t=n[e]*6,r=e*6;H[r]=t,H[r+1]=t+1,H[r+2]=t+2,H[r+3]=t+3,H[r+4]=t+4,H[r+5]=t+5}U.needsUpdate=!0,q=performance.now()-e,Y=t.clone()};ie();let ae=0,$=()=>{ae=requestAnimationFrame($),S.update();let e=performance.now(),t=x.position.distanceToSquared(Y)>.02;K&&(t||e-J>900)&&e-J>90&&(J=e,ie());let n=y.domElement;z.uViewport.value.set(n.width/y.getPixelRatio(),n.height/y.getPixelRatio()),z.uView.value.copy(x.matrixWorldInverse),z.uProj.value.copy(x.projectionMatrix),z.uFocal.value=n.height/y.getPixelRatio()*.5/Math.tan(f.degToRad(x.fov*.5)),y.render(b,x),Z+=1,Q+=1,Q>=30&&(X=Z*1e3/(e-$._t||1),$._t=e,Z=0,Q=0)};$();let oe=()=>{let e=g.clientWidth,t=g.clientHeight;y.setSize(e,t,!1),x.aspect=e/Math.max(1,t),x.updateProjectionMatrix()};return window.addEventListener(`resize`,oe),v(1,`就绪`),{stats(){return{gaussians:A.count,fps:X,sortMs:q,bytes:D}},resetCamera(){x.position.set(24,16,28),S.target.set(0,1.6,0),S.update()},setSorting(e){return K=e,K},dispose(){cancelAnimationFrame(ae),window.removeEventListener(`resize`,oe),S.dispose(),R.dispose(),B.dispose(),y.dispose()}}}export{g as createSplatViewer};
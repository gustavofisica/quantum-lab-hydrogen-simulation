import * as THREE from 'https://esm.sh/three@0.160.0';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';

// --- ESTADO GLOBAL DA APLICAÇÃO ---
const App = {
    n: 2, l: 1, m: 0,
    mode: '3D',       // '3D' ou '2D'
    plane: 'XZ',      // 'XY', 'XZ', 'YZ'
    sliceOffset: 0.0, // Altura do corte 2D (resolve o plano nodal)
    palette: 'magma',
    quality: 60,
    showAxes: true,
    // Controle de Câmera 2D
    zoom2D: 1.0,
    panX: 0,
    panY: 0
};

let abortCtrl = null; // Controle para cancelar cálculos anteriores
let scene, camera, renderer, controls, points, axesGroup;

// --- PALETAS DE CORES ---
const PALETTES = {
    magma:       { stops: [0, 0.4, 1], colors: [0x000000, 0xcf1b66, 0xffffaa] },
    neon:        { stops: [0, 0.2, 1], colors: [0x000000, 0x00ff00, 0x00ffff] },
    radioactive: { stops: [0, 0.4, 1], colors: [0x051a05, 0x44ee00, 0xffffaa] },
    ice:         { stops: [0, 0.5, 1], colors: [0x000510, 0x004488, 0xaaddff] },
    sunset:      { stops: [0, 0.5, 1], colors: [0x1a051a, 0xff5500, 0xffcc00] }
};

function getColor(t, pName) {
    const p = PALETTES[pName] || PALETTES.magma;
    const stops = p.stops; const colors = p.colors;
    for(let i=0; i < stops.length - 1; i++){
        if(t >= stops[i] && t <= stops[i+1]){
            const localT = (t - stops[i]) / (stops[i+1] - stops[i]);
            return new THREE.Color(colors[i]).lerp(new THREE.Color(colors[i+1]), localT);
        }
    }
    return new THREE.Color(colors[colors.length-1]);
}

// --- FÍSICA QUÂNTICA (Math Kernel) ---

// 1. Polinômios de Laguerre Generalizados
function genLaguerre(n, alpha, x) {
    if (n === 0) return 1;
    if (n === 1) return 1 + alpha - x;
    let L0 = 1, L1 = 1 + alpha - x;
    for (let k = 1; k < n; k++) {
        let Lnext = ((2 * k + 1 + alpha - x) * L1 - (k + alpha) * L0) / (k + 1);
        L0 = L1; L1 = Lnext;
    }
    return L1;
}

// 2. Polinômios de Legendre Associados
function legendreP(l, m, x) {
    m = Math.abs(m);
    let pmm = Math.pow(Math.sqrt(Math.max(0, 1 - x * x)), m);
    if (m % 2 === 1) pmm *= -1;
    if (l === m) return pmm;
    let pmm1 = x * (2 * m + 1) * pmm;
    if (l === m + 1) return pmm1;
    let p_prev = pmm, p_curr = pmm1;
    for (let k = m + 2; k <= l; k++) {
        let p_next = (x * (2 * k - 1) * p_curr - (k + m - 1) * p_prev) / (k - m);
        p_prev = p_curr; p_curr = p_next;
    }
    return p_curr;
}

// 3. Densidade de Probabilidade |Psi|^2
function getDensity(r, theta, n, l, m) {
    let rho = (2.0 * r) / n;
    let lag = genLaguerre(n - l - 1, 2 * l + 1, rho);
    let R = Math.exp(-rho / 2) * Math.pow(rho, l) * lag;
    let Y = legendreP(l, m, Math.cos(theta));
    return (R * Y) ** 2;
}

// --- 3D ENGINE (THREE.JS) ---

function createTextSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = "bold 40px Arial";
    ctx.fillStyle = color;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(2, 2, 1);
    return sprite;
}

function initAxes() {
    axesGroup = new THREE.Group();
    // Eixos Linhas
    const axesHelper = new THREE.AxesHelper(12);
    axesGroup.add(axesHelper);

    // Eixos Textos
    const lblX = createTextSprite("X", "#ff5555"); lblX.position.set(13,0,0); axesGroup.add(lblX);
    const lblY = createTextSprite("Y", "#55ff55"); lblY.position.set(0,13,0); axesGroup.add(lblY);
    const lblZ = createTextSprite("Z", "#5555ff"); lblZ.position.set(0,0,13); axesGroup.add(lblZ);
    
    scene.add(axesGroup);
}

function init3D() {
    const container = document.getElementById('container-3d');
    // Verificação de Segurança
    if (!container) return;

    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(15, 15, 15);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    initAxes();
}

// --- RENDER 3D (MONTE CARLO) ---
async function render3D(signal) {
    if (!scene) return;
    if(points) { scene.remove(points); points.geometry.dispose(); }
    
    if(axesGroup) axesGroup.visible = App.showAxes;

    const totalPoints = 1000 * App.quality; 
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(totalPoints * 3);
    const col = new Float32Array(totalPoints * 3);

    const mat = new THREE.PointsMaterial({
        size: 0.15, vertexColors: true, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false
    });
    points = new THREE.Points(geo, mat);
    scene.add(points);

    const {n, l, m} = App;
    const bound = 2.5 * n * n + 5; 

    // Normalização
    let maxVal = 0;
    for(let r=0; r<bound; r+=0.5) maxVal = Math.max(maxVal, getDensity(r, Math.PI/4, n, l, m));
    if(maxVal === 0) maxVal = 0.0001;

    let count = 0;
    const btnText = document.querySelector('.btn-content');
    const bar = document.getElementById('progress-bar');
    if(btnText) btnText.textContent = `SIMULANDO NUVEM...`;

    while(count < totalPoints) {
        if(signal.aborted) return;

        // Gera lotes de pontos
        for(let k=0; k<2000 && count < totalPoints; k++) {
            let x = (Math.random()-0.5)*2*bound;
            let y = (Math.random()-0.5)*2*bound;
            let z = (Math.random()-0.5)*2*bound;
            let r = Math.sqrt(x*x+y*y+z*z);
            
            if(r===0 || r>bound) continue;
            
            let th = Math.acos(z/r);
            let prob = getDensity(r, th, n, l, m);
            let ratio = prob / maxVal;

            if(Math.random() < Math.pow(ratio, 0.6)) {
                let idx = count*3;
                pos[idx] = x; pos[idx+1] = y; pos[idx+2] = z;
                
                let c = getColor(ratio, App.palette);
                col[idx] = c.r; col[idx+1] = c.g; col[idx+2] = c.b;
                count++;
            }
        }

        geo.setDrawRange(0, count);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        points.geometry.attributes.position.needsUpdate = true;
        points.geometry.attributes.color.needsUpdate = true;

        if(bar) bar.style.width = Math.floor((count/totalPoints)*100) + "%";
        await new Promise(r => requestAnimationFrame(r));
    }

    if(btnText) btnText.textContent = "ATUALIZAR SIMULAÇÃO";
    if(bar) bar.style.width = "0%";
    updateStatus();
}

// --- RENDER 2D (COM SUPORTE A OFFSET E ZOOM) ---
async function render2D(signal) {
    const cvs = document.getElementById('canvas-2d');
    if(!cvs) return;

    const ctx = cvs.getContext('2d');
    const rect = cvs.parentElement.getBoundingClientRect();
    
    cvs.width = rect.width; cvs.height = rect.height;
    const w = cvs.width, h = cvs.height;

    ctx.fillStyle = "#000000"; ctx.fillRect(0,0,w,h);

    const {n, l, m, plane, sliceOffset} = App;
    
    const baseZoom = Math.min(w,h) / (3.0 * n * n + 15);
    const finalZoom = baseZoom * App.zoom2D;

    let maxVal = 0;
    for(let i=0; i<150; i++) maxVal = Math.max(maxVal, getDensity(i*(n*n)/50, Math.PI/4, n, l, m));
    if(maxVal === 0) maxVal = 0.001;

    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    const btnText = document.querySelector('.btn-content');
    const bar = document.getElementById('progress-bar');
    if(btnText) btnText.textContent = `RENDERIZANDO CORTE...`;

    // Qualidade adaptativa (pula pixels se qualidade for baixa)
    const step = App.quality < 40 ? 2 : 1;

    for(let py=0; py<h; py+=step) {
        if(signal.aborted) return;
        
        if(py % 40 === 0 && bar) {
            bar.style.width = Math.round((py/h)*100) + "%";
            await new Promise(r => requestAnimationFrame(r));
        }

        // Coord Y da Tela (com Pan)
        let screenY = (h/2 - py + App.panY) / finalZoom;

        for(let px=0; px<w; px+=step) {
            // Coord X da Tela (com Pan)
            let screenX = (px - w/2 - App.panX) / finalZoom;
            
            let x, y, z;
            
            // --- LÓGICA DE MAP DE PLANOS COM OFFSET ---
            // O sliceOffset é aplicado na dimensão perpendicular ao plano
            if(plane === 'XZ') {
                x = screenX;
                z = screenY;
                y = sliceOffset; // Y é profundidade
            } else if(plane === 'YZ') {
                y = screenX;
                z = screenY;
                x = sliceOffset; // X é profundidade
            } else { // XY
                x = screenX;
                y = screenY;
                z = sliceOffset; // Z é profundidade (Fundamental para ver orbitais em pz)
            }

            // Converte Cartesiano -> Esférico
            let r = Math.sqrt(x*x + y*y + z*z);
            // Evitar NaN quando r=0
            let theta = (r===0) ? 0 : Math.acos(z/r);

            let val = getDensity(r, theta, n, l, m);
            let intens = Math.pow(val/maxVal, 0.5); // Gamma correction
            let c = getColor(intens, App.palette);

            // Preenche o pixel (ou bloco de pixels se step > 1)
            for(let sy=0; sy<step && py+sy<h; sy++) {
                for(let sx=0; sx<step && px+sx<w; sx++) {
                    let idx = ((py+sy)*w + (px+sx))*4;
                    data[idx] = c.r*255; 
                    data[idx+1] = c.g*255; 
                    data[idx+2] = c.b*255; 
                    data[idx+3] = 255;
                }
            }
        }
    }

    ctx.putImageData(imgData, 0, 0);

    // Desenhar Eixos 2D
    if(App.showAxes) {
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1; ctx.font = "12px monospace"; ctx.fillStyle = "white";
        const cx = w/2 + App.panX; 
        const cy = h/2 + App.panY;

        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
        ctx.fillText(plane==='YZ'?'Y':'X', w-20, cy-5);

        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
        ctx.fillText(plane==='XY'?'Y':'Z', cx+5, 20);
    }

    if(btnText) btnText.textContent = "ATUALIZAR SIMULAÇÃO";
    if(bar) bar.style.width = "0%";
    updateStatus();
}

// --- CONTROLE UI ---

function triggerRender() {
    if(abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    
    // Atualiza Estado
    App.n = parseInt(document.getElementById('input-n').value);
    App.l = parseInt(document.getElementById('input-l').value);
    App.m = parseInt(document.getElementById('input-m').value);
    App.quality = parseInt(document.getElementById('input-quality').value);
    App.palette = document.getElementById('select-palette').value;
    App.plane = document.getElementById('select-plane').value;
    App.showAxes = document.getElementById('check-axes').checked;
    
    // Atualiza Offset apenas se elemento existir
    const offEl = document.getElementById('input-offset');
    if(offEl) App.sliceOffset = parseFloat(offEl.value);

    if(App.mode === '3D') render3D(abortCtrl.signal);
    else render2D(abortCtrl.signal);
}

function updateStatus() {
    const subs = ['s','p','d','f','g'];
    document.getElementById('status-orbital').textContent = `Orbital: ${App.n}${subs[App.l] || '?'} (m=${App.m})`;
    
    let txt = App.mode === '3D' ? '3D Volumétrico' : `Corte ${App.plane} (Offset: ${App.sliceOffset})`;
    document.getElementById('status-coords').textContent = txt;
    document.getElementById('disp-q').textContent = App.quality + "%";
}

function setupEvents() {
    const ids = ['input-n', 'input-l', 'input-m', 'input-quality', 'select-palette', 'select-plane', 'input-offset'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.onchange = triggerRender;
    });

    // Inputs com atualização visual ao arrastar (Input event)
    document.getElementById('input-n').oninput = (e) => {
        document.getElementById('disp-n').textContent = e.target.value;
        const lIn = document.getElementById('input-l');
        lIn.max = e.target.value - 1;
        if(parseInt(lIn.value) > lIn.max) { lIn.value = lIn.max; document.getElementById('disp-l').textContent = lIn.value; }
    };
    document.getElementById('input-l').oninput = (e) => {
        document.getElementById('disp-l').textContent = e.target.value + " ("+['s','p','d','f'][e.target.value]+")";
        const mIn = document.getElementById('input-m');
        mIn.max = e.target.value; mIn.min = -e.target.value;
    };
    document.getElementById('input-m').oninput = (e) => document.getElementById('disp-m').textContent = e.target.value;
    document.getElementById('input-quality').oninput = (e) => document.getElementById('disp-q').textContent = e.target.value + "%";
    
    const offsetIn = document.getElementById('input-offset');
    if(offsetIn) {
        offsetIn.oninput = (e) => {
            document.getElementById('disp-offset').textContent = parseFloat(e.target.value).toFixed(1);
            // Renderiza enquanto arrasta no 2D para feedback imediato
            if(App.mode === '2D') { 
                App.sliceOffset = parseFloat(e.target.value);
                // Throttle simples
                requestAnimationFrame(() => { if(!abortCtrl.signal.aborted) triggerRender(); });
            }
        };
    }

    document.getElementById('check-axes').onchange = (e) => {
        App.showAxes = e.target.checked;
        if(App.mode==='3D' && axesGroup) axesGroup.visible = App.showAxes;
        else if(App.mode==='2D') triggerRender();
    };

    document.getElementById('btn-render').onclick = triggerRender;

    document.getElementById('toggle-sidebar').onclick = () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
        setTimeout(() => {
            const container = document.getElementById('container-3d');
            if(camera && container) {
                camera.aspect = container.clientWidth / container.clientHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(container.clientWidth, container.clientHeight);
            }
            if(App.mode === '2D') triggerRender();
        }, 350);
    };

    ['btn-3d', 'btn-2d'].forEach(id => {
        document.getElementById(id).onclick = (e) => {
            document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            App.mode = e.target.getAttribute('data-mode');
            
            document.getElementById('container-3d').classList.toggle('hidden', App.mode !== '3D');
            document.getElementById('canvas-2d').classList.toggle('hidden', App.mode !== '2D');
            document.getElementById('section-2d-opts').classList.toggle('hidden', App.mode !== '2D');
            
            triggerRender();
        };
    });

    // Zoom & Pan no Canvas
    const cvs = document.getElementById('canvas-2d');
    let isDragging = false, lastX=0, lastY=0;

    if(cvs) {
        cvs.onwheel = (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.9;
            App.zoom2D *= factor;
            if(!abortCtrl || !abortCtrl.signal.aborted) triggerRender();
        };

        cvs.onmousedown = (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; cvs.style.cursor='grabbing'; };
        window.addEventListener('mouseup', () => { isDragging = false; if(cvs) cvs.style.cursor='default'; });
        window.addEventListener('mousemove', (e) => {
            if(!isDragging) return;
            App.panX += e.clientX - lastX;
            App.panY += e.clientY - lastY;
            lastX = e.clientX; lastY = e.clientY;
            requestAnimationFrame(() => { if(!abortCtrl.signal.aborted) triggerRender(); });
        });
    }
}

function animate() {
    requestAnimationFrame(animate);
    if(App.mode === '3D' && controls && renderer && scene) {
        controls.update();
        renderer.render(scene, camera);
    }
}

// --- STARTUP SEGURO ---
window.addEventListener('DOMContentLoaded', () => {
    init3D();
    setupEvents();
    triggerRender();
    animate();
});
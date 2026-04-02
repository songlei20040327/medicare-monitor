// ==========================================
// 1. 算法引擎状态 (复刻 Python 后端)
// ==========================================
const FPS = 100;
const BUFFER_SIZE = FPS * 10;
let ppgBuffer = { red: new Array(BUFFER_SIZE).fill(0), ir: new Array(BUFFER_SIZE).fill(0) };
let pressBuffer = new Array(BUFFER_SIZE).fill(0);
let lastFiltPress = 0;
let rxBuffer = "";

// 滤波函数：EMA 指数移动平均 (解决波形锯齿)
const ema = (cur, last, alpha) => (alpha * cur) + (1 - alpha) * last;

// 寻峰函数：用于检测呼吸周期
function findPeaks(data, distance, prominence) {
    let peaks = [];
    for (let i = 1; i < data.length - 1; i++) {
        if (data[i] > data[i-1] && data[i] > data[i+1] && data[i] > prominence) {
            if (peaks.length === 0 || i - peaks[peaks.length-1] > distance) {
                peaks.push(i);
            }
        }
    }
    return peaks;
}

// 核心计算逻辑：心率 (自相关) 与 呼吸 (寻峰)
function runAlgorithms() {
    // --- 心率计算 ---
    const irSlice = ppgBuffer.ir.slice(-400);
    let hr = null;
    let maxCorr = 0, bestLag = 0;
    // 搜索 40-180 BPM 对应的延迟范围
    for (let lag = 33; lag < 150; lag++) {
        let corr = 0;
        for (let i = 0; i < 250; i++) corr += irSlice[i] * irSlice[i + lag];
        if (corr > maxCorr) { maxCorr = corr; bestLag = lag; }
    }
    if (maxCorr > 0) hr = Math.round((60 * FPS) / bestLag);

    // --- 呼吸计算 ---
    const pSlice = pressBuffer.slice(-800);
    const range = Math.max(...pSlice) - Math.min(...pSlice);
    let rr = null, peep = null;
    if (range > 0.3) {
        const troughs = findPeaks(pSlice.map(x => -x), FPS * 1.0, -Math.max(...pSlice));
        if (troughs.length >= 2) {
            rr = Math.round(60 / ((troughs[troughs.length-1] - troughs[troughs.length-2]) / FPS));
            peep = Math.abs(pSlice[troughs[troughs.length-1]]).toFixed(1);
        }
    }
    return { hr, rr, peep };
}

// ==========================================
// 2. 图表系统 (ECharts)
// ==========================================
function initRing(id, color, max) {
    const c = echarts.init(document.getElementById(id));
    c.setOption({
        series: [{
            type: 'gauge', radius: '100%', startAngle: 90, endAngle: -270,
            pointer: { show: false }, progress: { show: true, width: 8, itemStyle: { color } },
            axisLine: { lineStyle: { width: 8, color: [[1, '#f1f5f9']] } },
            splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
            min: 0, max, detail: { fontSize: 14, fontWeight: '900', offsetCenter: [0, 0], formatter: '{value}' },
            data: [{ value: 0 }]
        }]
    });
    return c;
}

const chartSpo2 = initRing('ring-spo2', '#818cf8', 100);
const chartCo2 = initRing('ring-co2', '#a78bfa', 10);
const chartO2 = initRing('ring-o2', '#2dd4bf', 100);

const optWave = (color) => ({
    animation: false, grid: { left: 0, right: 0, top: 10, bottom: 0 },
    xAxis: { type: 'category', show: false }, yAxis: { type: 'value', show: false, scale: true },
    series: [{ type: 'line', showSymbol: false, smooth: true, lineStyle: { color, width: 2 }, data: [] }]
});
const ppgChart = echarts.init(document.getElementById('chart-ppg'));
const pressChart = echarts.init(document.getElementById('chart-press'));
ppgChart.setOption(optWave('#fb7185'));
pressChart.setOption(optWave('#fb923c'));

// ==========================================
// 3. 蓝牙与数据解析 (适配 Bluefy)
// ==========================================
async function startBle() {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Venti' }, { namePrefix: 'Medicare' }],
            optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e']
        });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
        const char = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
        
        await char.startNotifications();
        char.addEventListener('characteristicvaluechanged', (e) => {
            const str = new TextDecoder().decode(e.target.value);
            rxBuffer += str;
            if (rxBuffer.includes('\n')) {
                let lines = rxBuffer.split('\n');
                rxBuffer = lines.pop();
                lines.forEach(parseLine);
            }
        });
        document.getElementById('ble-status').innerText = "已监控";
    } catch (err) { alert("连接失败: " + err); }
}

function parseLine(line) {
    if (!line.trim()) return;
    
    // 模拟 Python 解析逻辑
    if (line.includes('P:')) {
        const r = parseFloat(line.match(/R:([-\d.]+)/)?.[1]);
        const i = parseFloat(line.match(/I:([-\d.]+)/)?.[1]);
        const p = parseFloat(line.match(/P:([-\d.]+)/)?.[1]);

        if (r === -1) { // 离线检测
            document.getElementById('val-hr').innerText = '--';
            return;
        }

        ppgBuffer.red.push(r); ppgBuffer.red.shift();
        ppgBuffer.ir.push(i); ppgBuffer.ir.shift();
        
        lastFiltPress = ema(p, lastFiltPress, 0.3);
        pressBuffer.push(lastFiltPress); pressBuffer.shift();

        // 更新波形
        ppgChart.setOption({ series: [{ data: ppgBuffer.ir.slice(-100) }] });
        pressChart.setOption({ series: [{ data: pressBuffer.slice(-100) }] });
    }

    // 环境参数解析
    const co2 = line.match(/CO2:([-\d.]+)/)?.[1];
    const flow = line.match(/Flow:([-\d.]+)/)?.[1];
    if (co2) chartCo2.setOption({ series: [{ data: [{ value: co2 }] }] });
    if (flow) document.getElementById('val-flow').innerText = flow;

    // 算法节流执行 (每500ms算一次)
    throttleAlgo();
}

let lastTick = 0;
function throttleAlgo() {
    if (Date.now() - lastTick < 500) return;
    const res = runAlgorithms();
    document.getElementById('val-hr').innerText = res.hr || '--';
    document.getElementById('val-rr').innerText = res.rr || '--';
    document.getElementById('val-peep').innerText = res.peep || '--';
    lastTick = Date.now();
}

document.getElementById('btn-connect').onclick = startBle;
setInterval(() => { document.getElementById('realtime-clock').innerText = new Date().toTimeString().split(' ')[0]; }, 1000);

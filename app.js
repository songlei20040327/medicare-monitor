// ==========================================
// 1. 基础功能与 UI 管理
// ==========================================
function updateClock() {
    const now = new Date();
    document.getElementById('realtime-clock').innerText = now.toTimeString().split(' ')[0];
}
setInterval(updateClock, 1000);
updateClock();

// 蓝牙相关配置
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let bluetoothDevice = null;
let gattServer = null;
let txCharacteristic = null;
let rxBuffer = "";

// UI 元素
const bleModal = document.getElementById('ble-modal');
const deviceList = document.getElementById('device-list');
const btnScan = document.getElementById('btn-scan');
const bleStatusNav = document.getElementById('ble-status-nav');

// ==========================================
// 2. ECharts 初始化 (保持原样)
// ==========================================
function createDonutChart(domId, color, maxVal) {
    let chart = echarts.init(document.getElementById(domId));
    chart.setOption({
        series: [{
            type: 'gauge', radius: '85%', startAngle: 90, endAngle: -270,
            pointer: { show: false }, progress: { show: true, roundCap: true, width: 15, itemStyle: { color: color } },
            axisLine: { lineStyle: { width: 14, color: [[1, '#F1F5F9']] } },
            splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
            min: 0, max: maxVal, data: [{ value: 0 }],
            detail: { fontSize: 20, fontWeight: '900', color: '#1E293B', formatter: '{value}', offsetCenter: ['0%', '0%'] }
        }]
    });
    return chart;
}

const chartSpo2 = createDonutChart('ring-spo2', '#818CF8', 100);
const chartCo2 = createDonutChart('ring-co2', '#A78BFA', 10);
const chartO2 = createDonutChart('ring-o2', '#2DD4BF', 100);

const chartPPG = echarts.init(document.getElementById('chart-ppg'));
const chartPress = echarts.init(document.getElementById('chart-press'));

const baseLineOpt = {
    animation: false,
    grid: { left: 10, right: 10, bottom: 10, top: 35, containLabel: true },
    xAxis: { type: 'category', show: false },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#F1F5F9', type: 'dashed' } }, scale: true }
};

chartPPG.setOption({ ...baseLineOpt, series: [{ type: 'line', showSymbol: false, smooth: true, lineStyle: { color: '#FB7185' }, data: [] }] });
chartPress.setOption({ ...baseLineOpt, series: [{ type: 'line', showSymbol: false, smooth: true, lineStyle: { color: '#FB923C' }, data: [] }] });

// 数据缓冲区
let ppgWave = [];
let pressWave = [];

// ==========================================
// 3. Web Bluetooth 核心连接逻辑
// ==========================================

document.getElementById('btn-ble-menu').onclick = () => bleModal.classList.remove('hidden');
document.getElementById('btn-close-modal').onclick = () => bleModal.classList.add('hidden');

btnScan.onclick = async () => {
    try {
        console.log("正在请求蓝牙设备...");
        // Bluefy 会弹出系统原生的搜索界面
        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Venti' }, { namePrefix: 'Medicare' }],
            optionalServices: [SERVICE_UUID]
        });

        bleStatusNav.innerText = "Connecting...";
        
        // 建立 GATT 连接
        gattServer = await bluetoothDevice.gatt.connect();
        const service = await gattServer.getPrimaryService(SERVICE_UUID);
        txCharacteristic = await service.getCharacteristic(TX_CHAR_UUID);

        // 开启通知监听
        await txCharacteristic.startNotifications();
        txCharacteristic.addEventListener('characteristicvaluechanged', handleBleData);

        // 更新 UI 状态
        bleStatusNav.innerHTML = `<i class="fa-brands fa-bluetooth-b mr-2"></i>Connected`;
        bleModal.classList.add('hidden');
        console.log("蓝牙连接成功并开启监听");

    } catch (error) {
        console.error("蓝牙连接失败:", error);
        alert("连接失败: " + error.message);
    }
};

// ==========================================
// 4. 数据解析逻辑
// ==========================================

function handleBleData(event) {
    // 将蓝牙原始数据转换为文本
    const value = event.target.value;
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(value);

    rxBuffer += text;

    if (rxBuffer.includes('\n')) {
        let lines = rxBuffer.split('\n');
        rxBuffer = lines.pop(); // 留下最后不完整的一行
        lines.forEach(line => parseLine(line.trim()));
    }
}

function parseLine(line) {
    if (!line) return;
    console.log("RX:", line);

    // 1. 处理高频数据 R:xxx,I:xxx,P:xxx
    if (line.includes('P:')) {
        try {
            const pMatch = line.match(/P:([-\d.]+)/);
            if (pMatch) {
                const press = parseFloat(pMatch[1]);
                document.getElementById('val-peep').innerText = press.toFixed(2);
                pressWave.push(press);
                if (pressWave.length > 100) pressWave.shift();
                chartPress.setOption({ series: [{ data: pressWave }] });
            }
            const rMatch = line.match(/R:([-\d.]+)/);
            if (rMatch) {
                const red = parseFloat(rMatch[1]);
                if (red > 0) {
                    ppgWave.push(red);
                    if (ppgWave.length > 100) ppgWave.shift();
                    chartPPG.setOption({ series: [{ data: ppgWave }] });
                }
            }
        } catch (e) {}
    }

    // 2. 处理环境数据 O2:xx,Flow:xx
    if (line.includes('Flow:')) {
        const oMatch = line.match(/O2:([-\d.]+)/);
        const fMatch = line.match(/Flow:([-\d.]+)/);
        if (oMatch) chartO2.setOption({ series: [{ data: [{ value: oMatch[1] }] }] });
        if (fMatch) document.getElementById('val-flow').innerText = fMatch[1];
    }

    // 3. 处理 SCD40 数据 Temp:xx Hum:xx
    if (line.includes('Temp:')) {
        const tMatch = line.match(/Temp:([-\d.]+)/);
        const hMatch = line.match(/Hum:([-\d.]+)/);
        if (tMatch) document.getElementById('val-temp').innerText = tMatch[1];
        if (hMatch) document.getElementById('val-hum').innerText = hMatch[1];
    }
}
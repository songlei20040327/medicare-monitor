// ==========================================
// 1. 初始化与 UI 管理
// ==========================================
function updateClock() {
    const clock = document.getElementById('realtime-clock');
    if(clock) clock.innerText = new Date().toTimeString().split(' ')[0];
}
setInterval(updateClock, 1000);
updateClock();

// 蓝牙 UUID (需与 ESP32 匹配)
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let rxBuffer = "";
const MAX_WAVE_POINTS = 100; // 波形图保持的点数

// ==========================================
// 2. 滤波逻辑 (移植自 Python 代码)
// ==========================================
// 指数移动平均 (EMA) 滤波器状态
let filteredData = {
    press: 0,
    spo2: 98, // 初始值假设为正常范围
    co2: 0,
    o2: 21,
    alpha_wave: 0.4, // 波形滤波系数 (越小越平滑，延迟越大)
    alpha_val: 0.1   // 数值滤波系数 (越小越平滑)
};

/**
 * 计算 EMA 滤波
 * @param {number} current_value - 当前原始值
 * @param {number} last_filtered - 上一次滤波值
 * @param {number} alpha - 滤波系数 (0-1)
 */
function calculate_ema(current_value, last_filtered, alpha) {
    if (last_filtered === undefined || isNaN(last_filtered)) return current_value;
    return (current_value * alpha) + (last_filtered * (1 - alpha));
}

// ==========================================
// 3. ECharts 初始化 (圆环 + 波形)
// ==========================================
// 圆环图辅助函数
function createRingChart(domId, color, maxVal) {
    let chart = echarts.init(document.getElementById(domId));
    chart.setOption({
        series: [{
            type: 'gauge', radius: '100%', startAngle: 90, endAngle: -270,
            pointer: { show: false }, progress: { show: true, roundCap: true, width: 10, itemStyle: { color: color } },
            axisLine: { lineStyle: { width: 9, color: [[1, '#f1f5f9']] } },
            splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
            min: 0, max: maxVal, data: [{ value: 0 }],
            detail: { fontSize: 18, fontWeight: '900', color: '#1e293b', formatter: '{value}', offsetCenter: ['0%', '0%'] }
        }]
    });
    return chart;
}

// 波形图辅助函数
function createWaveChart(domId, color) {
    let chart = echarts.init(document.getElementById(domId));
    chart.setOption({
        animation: false,
        grid: { left: 10, right: 10, bottom: 10, top: 35, containLabel: true },
        xAxis: { type: 'category', show: false },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } }, scale: true, axisLabel: {color: '#94a3b8', fontSize: 10} },
        series: [{ type: 'line', showSymbol: false, smooth: true, lineStyle: { color: color, width: 2 }, data: [] }]
    });
    return chart;
}

// 实例化图表
const chartSpo2 = createRingChart('ring-spo2', '#818cf8', 100);
const chartCo2 = createRingChart('ring-co2', '#a78bfa', 10);
const chartO2 = createRingChart('ring-o2', '#2dd4bf', 100);
const chartPPG = createWaveChart('chart-ppg', '#fb7185');
const chartPress = createWaveChart('chart-press', '#fb923c');

// 数据缓冲区
let ppgData = new Array(MAX_WAVE_POINTS).fill(0);
let pressData = new Array(MAX_WAVE_POINTS).fill(0);

// ==========================================
// 4. Web Bluetooth 连接 (Bluefy 专用)
// ==========================================
const btnConnect = document.getElementById('btn-ble-connect');
const bleStatusNav = document.getElementById('ble-status-nav');

btnConnect.onclick = async () => {
    if (!navigator.bluetooth) {
        alert("请在 Bluefy 浏览器中打开此页面以使用蓝牙功能");
        return;
    }

    try {
        bleStatusNav.innerText = "正在搜索...";
        // 1. 请求设备
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Venti' }, { namePrefix: 'Medicare' }],
            optionalServices: [SERVICE_UUID]
        });

        bleStatusNav.innerText = "连接中...";
        // 2. 连接 GATT
        const server = await device.gatt.connect();
        // 3. 获取 Service
        const service = await server.getPrimaryService(SERVICE_UUID);
        // 4. 获取 Characteristic (TX)
        const characteristic = await service.getCharacteristic(TX_CHAR_UUID);

        // 5. 开启通知并添加监听器
        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', (event) => {
            // 将 ArrayBuffer 转为文本
            const text = new TextDecoder('utf-8').decode(event.target.value);
            handleBleRawData(text);
        });

        // 6. 更新 UI
        bleStatusNav.innerHTML = `<i class="fa-brands fa-bluetooth-b mr-1"></i>已连接`;
        btnConnect.classList.replace('bg-orange-500', 'bg-emerald-500');
        console.log("蓝牙连接完成");

    } catch (error) {
        bleStatusNav.innerText = "连接失败";
        console.error("蓝牙错误:", error);
    }
};

// ==========================================
// 5. 数据处理与滤波核心
// ==========================================
function handleBleRawData(text) {
    rxBuffer += text;
    if (rxBuffer.includes('\n')) {
        let lines = rxBuffer.split('\n');
        rxBuffer = lines.pop(); // 保留最后一个不完整行
        lines.forEach(line => parseFilteredLine(line.trim()));
    }
}

function parseFilteredLine(line) {
    if (!line) return;
    console.log("RX:", line); // Bluefy Console 可见

    // 处理波形图 (高频)
    if (line.includes('P:')) {
        const pMatch = line.match(/P:([-\d.]+)/);
        if (pMatch) {
            let rawPress = parseFloat(pMatch[1]);
            // 应用滤波 (用于波形)
            filteredData.press = calculate_ema(rawPress, filteredData.press, filteredData.alpha_wave);
            
            // 更新 UI 数字 (不滤波或使用极小 alpha)
            document.getElementById('val-peep').innerText = rawPress.toFixed(2);
            
            // 更新压力波形图
            pressData.push(filteredData.press);
            if (pressData.length > MAX_WAVE_POINTS) pressData.shift();
            chartPress.setOption({ series: [{ data: pressData }] });
        }
    }

    // 处理圆环数据 (EMA 平滑)
    if (line.includes('CO2:')) {
        // 假设原始行包含圆环和环境数据
        // 示例: CO2:5.2 Temp:25 Hum:60
        const co2Match = line.match(/CO2:([-\d.]+)/);
        const tMatch = line.match(/Temp:([-\d.]+)/);
        const hMatch = line.match(/Hum:([-\d.]+)/);

        if (co2Match) {
            let rawCo2 = parseFloat(co2Match[1]);
            // 针对数值应用 EMA 滤波 (解决跳变)
            filteredData.co2 = calculate_ema(rawCo2, filteredData.co2, filteredData.alpha_val);
            chartCo2.setOption({ series: [{ data: [{ value: filteredData.co2.toFixed(1) }] }] });
        }
        if (tMatch) document.getElementById('val-temp').innerText = parseFloat(tMatch[1]).toFixed(1);
        if (hMatch) document.getElementById('val-hum').innerText = parseFloat(hMatch[1]).toFixed(1);
    }

    // 处理 O2 和流量
    if (line.includes('Flow:')) {
        const oMatch = line.match(/O2:([-\d.]+)/);
        const fMatch = line.match(/Flow:([-\d.]+)/);

        if (oMatch) {
            let rawO2 = parseFloat(oMatch[1]);
            filteredData.o2 = calculate_ema(rawO2, filteredData.o2, filteredData.alpha_val);
            chartO2.setOption({ series: [{ data: [{ value: filteredData.o2.toFixed(1) }] }] });
        }
        if (fMatch) document.getElementById('val-flow').innerText = parseFloat(fMatch[1]).toFixed(1);
    }
}

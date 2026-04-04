// ==========================================
// 1. 时钟管理
// ==========================================
function updateClock() {
    const now = new Date();
    document.getElementById('realtime-clock').innerText = 
        [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => n.toString().padStart(2, '0')).join(':');
}
setInterval(updateClock, 1000); updateClock();

// ==========================================
// 2. ECharts 初始化 
// ==========================================
function createDonutChart(domId, color, maxVal) {
    let chart = echarts.init(document.getElementById(domId));
    let option = {
        series: [{
            type: 'gauge', 
            radius: '90%', // 适配 aspect-square 正方形盒子
            center: ['50%', '55%'], 
            startAngle: 90, endAngle: -270, 
            pointer: { show: false },
            progress: { show: true, roundCap: true, width: 6, itemStyle: { color: color } },
            axisLine: { lineStyle: { width: 6, color: [[1, '#F1F5F9']] } },
            splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
            min: 0, max: maxVal, data: [{ value: 0 }],
            detail: { fontSize: 14, fontFamily: 'sans-serif', fontWeight: '900', color: '#1E293B', formatter: '{value}', offsetCenter: ['0%', '0%'], valueAnimation: true }
        }]
    };
    chart.setOption(option);
    return chart;
}

const chartSpo2 = createDonutChart('ring-spo2', '#818CF8', 100); 
const chartCo2  = createDonutChart('ring-co2', '#A78BFA', 10);   
const chartO2   = createDonutChart('ring-o2', '#2DD4BF', 100);   

const chartPPG = echarts.init(document.getElementById('chart-ppg'));
const chartPress = echarts.init(document.getElementById('chart-press'));

let ppgData = Array(150).fill(0);
let pressData = Array(150).fill(0);
const xAxisData = Array.from({length: 150}, (_, i) => i);

const baseLineOpt = {
    animation: false,
    grid: { left: '-10px', right: '-10px', bottom: '0px', top: '5px', containLabel: false },
    xAxis: { type: 'category', data: xAxisData, show: false },
    yAxis: { type: 'value', show: false, scale: true }
};

chartPPG.setOption({ ...baseLineOpt, series: [{ type: 'line', showSymbol: false, smooth: true, lineStyle: { width: 2, color: '#FB7185' }, data: ppgData }] });
chartPress.setOption({ ...baseLineOpt, series: [{ type: 'line', showSymbol: false, smooth: true, lineStyle: { width: 2, color: '#FB923C' }, data: pressData }] });

window.addEventListener('resize', () => { [chartSpo2, chartCo2, chartO2, chartPPG, chartPress].forEach(c => c.resize()); });

setInterval(() => {
    chartPPG.setOption({ series: [{ data: ppgData }] });
    chartPress.setOption({ series: [{ data: pressData }] });
}, 33);

// ==========================================
// 3. Web Bluetooth API 核心逻辑 (对接 V8)
// ==========================================
let bluetoothDevice;
let rxCharacteristic;
let bleBuffer = "";

const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const RX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const btnConnect = document.getElementById('btn-connect');
const btnText = document.getElementById('ble-status');

function updateCard(id, val, isOffline) {
    document.getElementById(`val-${id}`).innerText = isOffline || val < 0 ? '--' : val;
    let block = document.getElementById(`block-${id}`);
    if (block) {
        if(isOffline || val < 0) block.classList.add('opacity-40', 'grayscale');
        else block.classList.remove('opacity-40', 'grayscale');
    }
}

btnConnect.addEventListener('click', async () => {
    if (bluetoothDevice && bluetoothDevice.gatt.connected) {
        bluetoothDevice.gatt.disconnect();
        return;
    }

    try {
        btnText.innerText = "正在扫描...";
        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Venti_V8' }],
            optionalServices: [SERVICE_UUID]
        });

        bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);

        btnText.innerText = "连接中...";
        const server = await bluetoothDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        rxCharacteristic = await service.getCharacteristic(RX_UUID);
        
        await rxCharacteristic.startNotifications();
        rxCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);

        btnConnect.classList.replace('bg-orange-500', 'bg-emerald-500');
        btnConnect.classList.replace('shadow-orange-200', 'shadow-emerald-200');
        btnConnect.innerHTML = `<i class="fa-solid fa-link-slash mr-1"></i><span id="ble-status">断开连接</span>`;

    } catch (error) {
        console.error("蓝牙连接失败:", error);
        btnText.innerText = "连接设备";
    }
});

function onDisconnected() {
    btnConnect.classList.replace('bg-emerald-500', 'bg-orange-500');
    btnConnect.classList.replace('shadow-emerald-200', 'shadow-orange-200');
    btnConnect.innerHTML = `<i class="fa-brands fa-bluetooth-b mr-1"></i><span id="ble-status">连接设备</span>`;
}

// ==========================================
// 4. 解析 ESP32 V8 传来的字符串协议
// ==========================================
function handleNotifications(event) {
    const value = new TextDecoder().decode(event.target.value);
    bleBuffer += value;
    
    let lines = bleBuffer.split('\n');
    bleBuffer = lines.pop(); 

    for (let line of lines) {
        line = line.trim();
        if(!line) continue;

        if (line.startsWith("W:")) {
            const parts = line.substring(2).split(',');
            if (parts.length >= 2) {
                ppgData.push(parseFloat(parts[0]));
                pressData.push(parseFloat(parts[1]));
                if(ppgData.length > 150) ppgData.shift();
                if(pressData.length > 150) pressData.shift();
            }
        } 
        else if (line.startsWith("V:")) {
            try {
                const groups = line.split('|');
                const vitals = groups[0].substring(2).split(','); 
                const envs = groups[1].substring(2).split(',');

                let spo2 = parseFloat(vitals[1]);
                let co2 = parseFloat(envs[0]);
                let o2 = parseFloat(envs[3]);
                
                chartSpo2.setOption({ series: [{ data: [{ value: spo2 > 0 ? spo2 : 0 }] }] });
                chartCo2.setOption({ series: [{ data: [{ value: co2 > 0 ? co2.toFixed(2) : 0 }] }] });
                chartO2.setOption({ series: [{ data: [{ value: o2 > 0 ? o2.toFixed(1) : 0 }] }] });

                let temp = parseFloat(envs[1]);
                let hum = parseFloat(envs[2]);
                document.getElementById('val-temp').innerText = temp > 0 ? temp.toFixed(1) : '--';
                document.getElementById('val-hum').innerText = hum > 0 ? hum.toFixed(1) : '--';

                updateCard('hr', parseFloat(vitals[0]), parseFloat(vitals[0]) < 0);
                updateCard('rr', parseFloat(vitals[2]), parseFloat(vitals[2]) < 0);
                updateCard('peep', parseFloat(vitals[3]), parseFloat(vitals[2]) < 0);
                
                let flow = parseFloat(envs[4]);
                updateCard('flow', flow > 0 ? flow.toFixed(1) : -1, flow <= 0);

            } catch (e) {
                console.error("数据解析错误:", line);
            }
        }
    }
}

(() => {
  const root = document.getElementById('iotdash');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = 'true';
  const $ = id => document.getElementById(id);

  const names = ['ESP32-NODE-01','ESP8266-NODE-02','RPI-GATEWAY-01','ESP32-NODE-04','ESP32-NODE-05','SENSOR-NODE-06','ESP8266-NODE-07','SENSOR-NODE-08'];
  const types = ['ESP32','ESP8266','Gateway','ESP32','ESP32','Sensor','ESP8266','Sensor'];
  const devices = names.map((name, i) => ({
    name, type: types[i], temp: 25 + Math.random() * 5,
    hum: 50 + Math.random() * 15, online: i !== 7
  }));
  const alerts = [
    {level:'warning', title:'High temperature detected', desc:'ESP32-NODE-04 · Temperature above threshold', time:'1 min ago'},
    {level:'success', title:'Gateway connection established', desc:'RPI-GATEWAY-01 · Connection restored', time:'4 min ago'},
    {level:'info', title:'New telemetry received', desc:'ESP8266-NODE-02 · Sensor update received', time:'8 min ago'}
  ];
  const history = {
    temp: Array.from({length:30}, () => 27 + Math.random()*3),
    humidity: Array.from({length:30}, () => 50 + Math.random()*15),
    pressure: Array.from({length:30}, () => 1008 + Math.random()*9)
  };
  const icons = {ESP32:'◈', ESP8266:'⌁', Gateway:'▣', Sensor:'◉'};
  let packets = 12480, paused = false, metric = 'temp';

  function deviceRow(d) {
    return `<div class="device">
      <div class="device-icon">${icons[d.type]}</div>
      <div class="device-info"><div class="device-name">${d.name}</div><div class="device-type">${d.type}</div></div>
      <div class="device-values">${d.temp.toFixed(1)} °C<br>${d.hum.toFixed(0)}% RH</div>
      <div class="device-status ${d.online?'':'offline'}">${d.online?'● Online':'● Offline'}</div>
    </div>`;
  }
  function alertRow(a) {
    const color = a.level === 'warning' ? '#e9a45e' : a.level === 'success' ? '#28c58b' : '#48a5ff';
    return `<div class="alert-row"><span class="alert-symbol" style="color:${color}">●</span>
      <div class="alert-copy"><div class="alert-title">${a.title}</div><div class="alert-desc">${a.desc}</div></div>
      <span class="alert-time">${a.time}</span></div>`;
  }
  function render() {
    $('devicepreview').innerHTML = devices.slice(0,4).map(deviceRow).join('');
    $('alertpreview').innerHTML = alerts.slice(0,3).map(alertRow).join('');
    $('devicetable').innerHTML = devices.map(d => `<tr>
      <td><strong>${d.name}</strong></td><td>${d.type}</td>
      <td>${d.temp.toFixed(1)} °C</td><td>${d.hum.toFixed(1)}%</td>
      <td style="color:${d.online?'#28c58b':'#e9a45e'}">${d.online?'● Online':'● Offline'}</td>
    </tr>`).join('');
    $('allalerts').innerHTML = alerts.map(alertRow).join('');
  }
  function drawChart() {
    const canvas = $('chart'), rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
    const w = rect.width, h = rect.height, pad = 29, data = history[metric];
    const min = Math.min(...data)-2, max = Math.max(...data)+2;
    const x = i => pad + i*(w-pad*2)/(data.length-1);
    const y = v => h-pad-(v-min)/(max-min)*(h-pad*2);
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted');
    ctx.font = '10px system-ui'; ctx.fillStyle = muted;
    for (let i=0;i<5;i++) {
      const yy = pad+i*(h-pad*2)/4;
      ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.beginPath();
      ctx.moveTo(pad,yy); ctx.lineTo(w-pad,yy); ctx.stroke();
      ctx.fillText((max-(max-min)*i/4).toFixed(0),1,yy-4);
    }
    const gradient = ctx.createLinearGradient(0,pad,0,h);
    gradient.addColorStop(0,'rgba(72,165,255,.25)'); gradient.addColorStop(1,'rgba(72,165,255,0)');
    ctx.beginPath(); data.forEach((v,i)=>i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v)));
    ctx.lineTo(x(data.length-1),h-pad); ctx.lineTo(x(0),h-pad); ctx.closePath();
    ctx.fillStyle=gradient; ctx.fill();
    ctx.beginPath(); data.forEach((v,i)=>i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v)));
    ctx.strokeStyle='#48a5ff'; ctx.lineWidth=2.3; ctx.stroke();
    ctx.beginPath(); ctx.arc(x(data.length-1),y(data.at(-1)),4,0,Math.PI*2);
    ctx.fillStyle='#48a5ff'; ctx.fill();
    ctx.fillStyle=muted; ctx.fillText('30 min ago',pad,h-4); ctx.fillText('Now',w-pad-20,h-4);
  }
  function update() {
    if (!paused) {
      devices.forEach(d => {
        if (!d.online) return;
        d.temp += (Math.random()-.5)*.7;
        d.hum = Math.max(30,Math.min(90,d.hum+(Math.random()-.5)*2));
      });
      Object.keys(history).forEach(k => {
        const base = k==='temp' ? devices[0].temp : k==='humidity' ? devices[0].hum : 1012;
        history[k].push(base+(Math.random()-.5)*(k==='pressure'?3:2));
        history[k].shift();
      });
      packets += Math.floor(18+Math.random()*14);
      $('packets').textContent = packets.toLocaleString();
      const active = devices.filter(d=>d.online);
      $('avgtemp').innerHTML = `${(active.reduce((sum,d)=>sum+d.temp,0)/active.length).toFixed(1)} <small>°C</small>`;
      $('latency').innerHTML = `${Math.floor(35+Math.random()*20)} <small>ms</small>`;
      $('rate').innerHTML = `${(18+Math.random()*12).toFixed(1)} <small>pkt/s</small>`;
      render(); drawChart();
    }
    $('clock').textContent = new Date().toLocaleTimeString();
  }
  function go(tab) {
    ['overview','devices','alerts'].forEach(id => $(id).hidden = id !== tab);
    document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active',btn.dataset.tab===tab));
    if (tab === 'overview') drawChart();
  }
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click',()=>go(btn.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click',()=>go(btn.dataset.goto)));
  $('pause').addEventListener('click',() => {
    paused = !paused;
    $('pause').textContent = paused ? '▶ Resume stream' : 'Ⅱ Pause stream';
  });
  $('metric').addEventListener('change',e => {
    metric = e.target.value;
    $('legend').textContent = {temp:'Temperature',humidity:'Humidity',pressure:'Pressure'}[metric];
    drawChart();
  });
  render(); drawChart(); update();
  setInterval(update,1800);
  window.addEventListener('resize',drawChart);
})();


const URL = "wss://gemini-live-api-f0vo.onrender.com/ws";

const localVideo = document.getElementById('localVideo');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectionStatus = document.getElementById('connectionStatus');
const logs = document.getElementById('logs');
const cameraToggle = document.getElementById('cameraToggle');
const micToggle = document.getElementById('micToggle');
const audioCanvas = document.getElementById('audioVisualizer');
const canvasCtx = audioCanvas.getContext('2d');

let websocket;
let mediaStream;
let audioContext;
let audioProcessor;
let videoInterval;
let isConnected = false;

// Audio Configuration
// Gemini supports 16kHz input. We'll try to get that from the browser or downsample.
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000; // Gemini Flash Live Native Audio preview outputs 24kHz

// Logging utility
function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${message}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
}

function updateStatus(status, className) {
    connectionStatus.textContent = status;
    connectionStatus.className = `status ${className}`;
}

async function startMedia() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 360 }
            },
            audio: {
                channelCount: 1,
                sampleRate: INPUT_SAMPLE_RATE,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        localVideo.srcObject = mediaStream;
        setupAudioProcessing();
    } catch (err) {
        log(`Media Error: ${err.message}`, 'error');
        console.error(err);
    }
}

function setupAudioProcessing() {
    // Input Audio Code
    // We used a deprecated ScriptProcessor for simplicity in a single file vs AudioWorklet
    // Ideally use AudioWorklet for production
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
        if (!isConnected || !micToggle.checked) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            let s = Math.max(-1, Math.min(1, inputData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send to WebSocket
        const base64Audio = arrayBufferToBase64(pcmData.buffer);
        sendToSocket({
            data: base64Audio,
            mime_type: "audio/pcm"
        });

        drawVisualizer(inputData);
    };
}

function sendToSocket(data) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify(data));
    }
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

function connect() {
    log('Connecting to ' + URL + '...');
    websocket = new WebSocket(URL);

    websocket.onopen = () => {
        isConnected = true;
        updateStatus('Connected', 'connected');
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        log('Connected to Gemini Live Backend', 'success');

        // Start Video Loop
        startVideoLoop();
    };

    websocket.onmessage = async (event) => {
        try {
            const response = JSON.parse(event.data);

            if (response.audio) {
                // Play Audio
                playAudioChunk(response.audio);
            }
            if (response.text) {
                log(`Gemini: ${response.text}`, 'received');
            }
            if (response.interrupted) {
                log('Interrupted', 'info');
                stopAudio();
            }
        } catch (e) {
            console.error("Error parsing message", e);
        }
    };

    websocket.onclose = () => {
        isConnected = false;
        updateStatus('Disconnected', 'error');
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        clearInterval(videoInterval);
        log('Disconnected', 'error');
    };

    websocket.onerror = (error) => {
        log('WebSocket Error', 'error');
        console.error(error);
    };
}

// Audio Playback Queue with Scheduling
let nextStartTime = 0;
let scheduledSources = [];

async function playAudioChunk(base64Audio) {
    try {
        const arrayBuffer = base64ToArrayBuffer(base64Audio);
        const int16 = new Int16Array(arrayBuffer);

        // Convert to Float32
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }

        const buffer = audioContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
        buffer.getChannelData(0).set(float32);

        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);

        // Schedule playback
        const currentTime = audioContext.currentTime;
        if (nextStartTime < currentTime) {
            nextStartTime = currentTime + 0.05;
        }

        source.start(nextStartTime);

        // Track source
        scheduledSources.push(source);
        source.onended = () => {
            const idx = scheduledSources.indexOf(source);
            if (idx > -1) scheduledSources.splice(idx, 1);
        };

        nextStartTime += buffer.duration;

    } catch (e) {
        console.error("Audio playback error", e);
    }
}

function stopAudio() {
    scheduledSources.forEach(s => {
        try { s.stop(); } catch (e) { }
    });
    scheduledSources = [];
    nextStartTime = 0;
}

function startVideoLoop() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Send frames every 1s (1 FPS) or faster if needed
    videoInterval = setInterval(() => {
        if (!isConnected || !cameraToggle.checked || !localVideo.srcObject) return;

        // Draw video frame to canvas
        // INCREASED QUALITY: Use full width or at least 1024px
        const originalWidth = localVideo.videoWidth || 640;
        const originalHeight = localVideo.videoHeight || 360;

        // Target at least 1024px width for better legibility
        const targetWidth = 1024;
        const scale = Math.min(1, targetWidth / originalWidth);

        const w = originalWidth * scale;
        const h = originalHeight * scale;

        canvas.width = w;
        canvas.height = h;

        ctx.drawImage(localVideo, 0, 0, w, h);

        // Get Base64 with Higher Quality (0.9)
        const dataURL = canvas.toDataURL('image/jpeg', 0.9);
        const base64Data = dataURL.split(',')[1];

        sendToSocket({
            data: base64Data,
            mime_type: "image/jpeg"
        });

    }, 1000);
}


// Visualizer
function drawVisualizer(dataArray) {
    const width = audioCanvas.width;
    const height = audioCanvas.height;

    canvasCtx.clearRect(0, 0, width, height);
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = '#4F46E5';
    canvasCtx.beginPath();

    const sliceWidth = width * 1.0 / dataArray.length;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] * 5 + 1; // Amp multiplication
        const y = v * height / 2;

        if (i === 0) {
            canvasCtx.moveTo(x, y);
        } else {
            canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    canvasCtx.lineTo(audioCanvas.width, audioCanvas.height / 2);
    canvasCtx.stroke();
}


// Event Listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', () => {
    if (websocket) websocket.close();
});

// Setup
startMedia();

// Resize canvas for visualizer
window.addEventListener('resize', () => {
    audioCanvas.width = audioCanvas.offsetWidth;
    audioCanvas.height = audioCanvas.offsetHeight;
});
audioCanvas.width = audioCanvas.offsetWidth;
audioCanvas.height = audioCanvas.offsetHeight;


const URL = "wss://gemini-live-api-f0vo.onrender.com/ws";

const localVideo = document.getElementById('localVideo');
let websocket = null;
let isConnected = false;
let audioContext = null;
let mediaStream = null;
let videoInterval = null;

// DOM Elements
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const themeToggle = document.getElementById('theme-toggle');
const micToggle = document.getElementById('mic-toggle');
const cameraToggle = document.getElementById('camera-toggle');
const audioCanvas = document.getElementById('audio-canvas');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const localVideo = document.getElementById('local-video'); // Fixed ID
const canvasCtx = audioCanvas.getContext('2d');

// --- PWA Service Worker Registration ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered'))
            .catch(err => console.error('SW registration failed: ', err));
    });
}

// --- Theme Management ---
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
    const icon = themeToggle.querySelector('.material-icons-round');
    icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

themeToggle.addEventListener('click', toggleTheme);
initTheme();


// --- Initialization ---
// Initialize AudioContext on user interaction
function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

// Resize canvas
function resizeCanvas() {
    audioCanvas.width = audioCanvas.parentElement.clientWidth;
    audioCanvas.height = audioCanvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();


// --- Events ---
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

micToggle.addEventListener('click', () => {
    if (mediaStream) {
        const audioTrack = mediaStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        micToggle.classList.toggle('muted', !audioTrack.enabled);
        micToggle.querySelector('.material-icons-round').textContent = audioTrack.enabled ? 'mic' : 'mic_off';
    }
});

cameraToggle.addEventListener('click', () => {
    // Just toggle the visual state for now, logic handled in loop
    const isOff = cameraToggle.classList.contains('muted');
    if (isOff) {
        cameraToggle.classList.remove('muted');
        cameraToggle.querySelector('.material-icons-round').textContent = 'videocam';
    } else {
        cameraToggle.classList.add('muted');
        cameraToggle.querySelector('.material-icons-round').textContent = 'videocam_off';
    }
});


// --- WebSocket & Media Logic ---

async function connect() {
    initAudioContext();

    // UI Updates
    document.body.classList.add('connected');
    statusText.textContent = "Connecting...";
    statusDot.className = "status-dot"; // reset

    try {
        // Get Media
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000
            },
            video: true
        });

        localVideo.srcObject = mediaStream;

        // Connect WS
        websocket = new WebSocket(URL);

        websocket.onopen = () => {
            isConnected = true;
            statusText.textContent = "Live";
            statusDot.classList.add('connected');

            // Start Capture
            startAudioCapture();
            startVideoLoop();
        };

        websocket.onclose = () => {
            handleDisconnect();
        };

        websocket.onerror = (e) => {
            console.error(e);
            handleDisconnect();
        };

        websocket.onmessage = handleMessage;

    } catch (e) {
        console.error("Connection failed", e);
        alert("Could not access camera/mic or connect.");
        handleDisconnect();
    }
}

function disconnect() {
    if (websocket) websocket.close();
    handleDisconnect();
}

function handleDisconnect() {
    isConnected = false;
    document.body.classList.remove('connected');
    statusText.textContent = "Ready";
    statusDot.className = "status-dot";

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    if (videoInterval) clearInterval(videoInterval);

    // Reset Audio
    stopAudio();
}

// --- Audio Capture ---
function startAudioCapture() {
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
        if (!isConnected) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Downsample to 16kHz if needed (Simple decimation)
        // Note: Context is 24k, we requested 16k from Mic but browser might give default.
        // For simplicity, we send raw PCM and let backend/model handle it, 
        // OR we can resample. 
        // Browser implementation of getUserMedia({sampleRate: 16000}) usually handles it.

        // Convert Float32 to Int16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            let s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Base64 encode
        const base64Audio = arrayBufferToBase64(pcm16.buffer);

        sendToSocket({
            data: base64Audio,
            mime_type: "audio/pcm"
        });

        // Drawing visualizer for Mic
        drawVisualizer(inputData);
    };
}

// --- Video Capture ---
function startVideoLoop() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Send frames every 1s
    videoInterval = setInterval(() => {
        if (!isConnected || cameraToggle.classList.contains('muted') || !localVideo.srcObject) return;

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

function sendToSocket(data) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify(data));
    }
}


// --- Message Handling ---
function handleMessage(event) {
    try {
        const message = JSON.parse(event.data);

        // Log to console only
        // console.log("Received:", message);

        if (message.audio) {
            playAudioChunk(message.audio);
        }
        if (message.interrupted) {
            console.log("Interrupted by model");
            stopAudio();
        }
    } catch (e) {
        console.error("Error parsing message", e);
    }
}


// --- Visualizer ---
function drawVisualizer(dataArray) {
    // Simple bar visualizer on the main canvas
    const width = audioCanvas.width;
    const height = audioCanvas.height;

    canvasCtx.clearRect(0, 0, width, height);

    // Draw a "pulse" line
    canvasCtx.lineWidth = 3;
    canvasCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--visualizer-color').trim();
    canvasCtx.beginPath();

    const sliceWidth = width * 1.0 / dataArray.length;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] * 200.0; // amplify
        const y = height / 2 + v;

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


// --- Robust Audio Playback ---
let audioQueue = [];
let isPlayingAudio = false;
let nextStartTime = 0;
let scheduledSources = [];

async function playAudioChunk(base64Audio) {
    // 1. Decode base64 to Float32
    const binaryString = window.atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
    }

    // 2. Add to queue
    audioQueue.push(float32);

    // 3. Trigger player if not running
    if (!isPlayingAudio) {
        scheduleNext();
    }
}

function scheduleNext() {
    if (audioQueue.length === 0) {
        isPlayingAudio = false;
        return;
    }

    isPlayingAudio = true;

    // Batch up to 200ms of data to reduce overhead (glitch reduction)
    let combinedLength = 0;
    const chunksToPlay = [];
    // 24000 samples/sec * 0.2 sec = 4800 samples
    const MAX_BATCH_SIZE = 4800;

    while (audioQueue.length > 0 && combinedLength < MAX_BATCH_SIZE) {
        const chunk = audioQueue.shift();
        chunksToPlay.push(chunk);
        combinedLength += chunk.length;
    }

    const combinedBuffer = new Float32Array(combinedLength);
    let offset = 0;
    chunksToPlay.forEach(chunk => {
        combinedBuffer.set(chunk, offset);
        offset += chunk.length;
    });

    const buffer = audioContext.createBuffer(1, combinedLength, 24000); // 24kHz output
    buffer.getChannelData(0).set(combinedBuffer);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const currentTime = audioContext.currentTime;

    // Critical: If we fell behind, reset start time (with small buffer).
    if (nextStartTime < currentTime) {
        nextStartTime = currentTime + 0.05;
    }

    source.start(nextStartTime);

    // Track source for stopping
    scheduledSources.push(source);
    source.onended = () => {
        const idx = scheduledSources.indexOf(source);
        if (idx > -1) scheduledSources.splice(idx, 1);
    };

    nextStartTime += buffer.duration;

    if (audioQueue.length > 0) {
        scheduleNext();
    }
}

function stopAudio() {
    scheduledSources.forEach(s => {
        try { s.stop(); } catch (e) { }
    });
    scheduledSources = [];
    audioQueue = [];
    nextStartTime = 0;
    isPlayingAudio = false;
}

// Helpers
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
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

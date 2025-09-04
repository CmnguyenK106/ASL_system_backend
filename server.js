import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

// Fix for wrtc CommonJS module
import pkg from 'wrtc';
const { RTCPeerConnection, RTCSessionDescription, nonstandard } = pkg;

const app = express();

// Middleware
app.use(cors({
    origin: true, // Allow all origins for development
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8008;
const I3D_SERVICE_URL = process.env.I3D_SERVICE_URL || 'http://localhost:5000';

// Processing settings
const PROCESSING_TIMEOUT = parseInt(process.env.PROCESSING_TIMEOUT || '10000', 10);
const ASL_PROCESSING_INTERVAL = parseInt(process.env.ASL_PROCESSING_INTERVAL || '200', 10);

// In-memory connection store
const connections = new Map();

// Helper: check microservice health
async function checkMicroserviceHealth(serviceUrl, serviceName) {
    try {
        const response = await fetch(`${serviceUrl}/health`, { method: 'GET', timeout: 5000 });
        if (!response.ok) return null;
        const data = await response.json();
        return data;
    } catch (error) {
        console.warn(`${serviceName} health check failed:`, error.message || error);
        return null;
    }
}

// ASL Session Processor
// Updated ASL Session Processor class for server.js
class ASLSessionProcessor {
    constructor(userId) {
        this.userId = userId;
        this.frameQueue = [];
        this.processing = false;
        this.glossSequence = [];
        this.sentenceHistory = [];
        this.currentSentence = '';
        this.lastRecognition = null;
        this.lastProcessedTime = 0;
        this.lastSentenceGeneration = 0;
        this.recognitionSequence = [];
    }

    enqueueFrame(frame) {
        if (this.frameQueue.length > 30) this.frameQueue.shift();
        this.frameQueue.push(frame);
        if (!this.processing) this.processLoop();
    }

    async processLoop() {
        this.processing = true;
        while (this.frameQueue.length > 0) {
            try {
                const frame = this.frameQueue.shift();
                const image = frame.image; // base64

                // Call I3D microservice
                const result = await this.callI3DMicroservice(image);

                // Process the result and send to client
                await this.processI3DResult(result);

                // Send result back to client
                const connection = connections.get(this.connectionId);
                if (connection && connection.dataChannel && 
                    connection.dataChannel.readyState === 'open') {

                    // Format result for client
                    const clientResult = this.formatASLResult(result);
                    connection.dataChannel.send(JSON.stringify(clientResult));

                    // If FastAPI service generated a sentence, send it immediately
                    if (result.sentence) {
                        this.handleGeminiSentence(result, connection);
                    }
                }

                this.lastProcessedTime = Date.now();

                // ASL processing interval (don't overwhelm the microservice)
                await new Promise(resolve => setTimeout(resolve, ASL_PROCESSING_INTERVAL));

            } catch (error) {
                console.error(`ASL processing error for connection ${this.connectionId}:`, error);
            }
        }
        this.processing = false;
    }

    async callI3DMicroservice(base64Image) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PROCESSING_TIMEOUT);
        try {
            const headers = {
                'Content-Type': 'application/json'
            };

            const payload = {
                session_id: this.userId,
                image: base64Image
            };

            const response = await fetch(`${I3D_SERVICE_URL}/infer`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`I3D microservice returned ${response.status}: ${errorText}`);
            }

            const result = await response.json();
            return result;
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('I3D microservice call failed:', error);
            throw error;
        }
    }

    async processI3DResult(i3dResponse) {
        // Track recognition sequence
        if (i3dResponse.recognition && i3dResponse.recognition !== this.lastRecognition) {
            this.lastRecognition = i3dResponse.recognition;
            this.recognitionSequence.push({
                label: i3dResponse.recognition,
                confidence: i3dResponse.confidence || 1.0,
                timestamp: new Date().toISOString()
            });

            // Keep only last 50
            if (this.recognitionSequence.length > 50) {
                this.recognitionSequence = this.recognitionSequence.slice(-50);
            }

            // Add gloss to sequence if present
            if (i3dResponse.current_gloss) {
                this.glossSequence.push(i3dResponse.current_gloss);
                if (this.glossSequence.length > 20) {
                    this.glossSequence = this.glossSequence.slice(-20);
                }
            }
        }
    }

    handleGeminiSentence(i3dResponse, connection) {
        // Handle sentence generated by FastAPI service via Gemini
        if (i3dResponse.sentence) {
            this.currentSentence = i3dResponse.sentence;
            this.sentenceHistory.push({
                sentence: i3dResponse.sentence,
                glosses: [...this.glossSequence],
                timestamp: i3dResponse.timestamp || new Date().toISOString(),
                source: 'gemini_flash'
            });

            if (this.sentenceHistory.length > 10) {
                this.sentenceHistory = this.sentenceHistory.slice(-10);
            }

            this.lastSentenceGeneration = Date.now();
            console.log(`Gemini sentence for session ${this.userId}: "${i3dResponse.sentence}"`);

            // Send sentence to client
            if (connection && connection.dataChannel && connection.dataChannel.readyState === 'open') {
                connection.dataChannel.send(JSON.stringify({
                    type: 'sentence_generated',
                    sentence: i3dResponse.sentence,
                    glosses: [...this.glossSequence],
                    confidence: 0.9, // High confidence from Gemini
                    timestamp: i3dResponse.timestamp || new Date().toISOString(),
                    session_id: this.userId,
                    source: 'gemini_flash'
                }));
            }

            // Clear glosses after generation (they were consumed by FastAPI service)
            this.glossSequence = [];
        }
    }

    formatASLResult(aslResponse) {
        return {
            type: 'asl_result',
            // New word recognized (only when new gesture detected)
            recognition: aslResponse.recognition || null,
            // Currently active gesture
            current_gloss: aslResponse.current_gloss || '',
            // Full sequence so far
            sentence: this.recognitionSequence.map(item => item.label).join(' '),
            // Additional info from FastAPI service
            confidence: aslResponse.confidence || null,
            glosses_count: aslResponse.glosses_count || 0,
            ready_for_sentence: aslResponse.ready_for_sentence || false,
            timestamp: aslResponse.timestamp || new Date().toISOString(),
            session_id: this.userId
        };
    }
}

// REST endpoints
app.get('/health', async (req, res) => {
    const i3dHealth = await checkMicroserviceHealth(I3D_SERVICE_URL, 'I3D Service');

    res.json({
        i3d: {
            connected: !!i3dHealth,
            health: i3dHealth,
            url: I3D_SERVICE_URL
        }
    });
});

// Simple test endpoint: send base64 image to I3D
app.post('/asl/test-infer', async (req, res) => {
    try {
        const image = req.body.image;
        const processor = new ASLSessionProcessor('test');
        const i3dResult = await processor.callI3DMicroservice(image);

        const testGlosses = ['hello', 'my', 'name', 'test'];
        const t5Result = null;

        res.json({
            i3d_result: i3dResult,
            test_glosses: testGlosses,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// WebRTC offer endpoint
app.post('/offer', async (req, res) => {
    try {
        const { sdp, session_id } = req.body;
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        const dataChannelLabel = 'frames';
        let connectionId = session_id || Math.random().toString(36).slice(2, 10);

        const dataChannel = pc.createDataChannel(dataChannelLabel);

        dataChannel.onopen = () => {
            console.log(`Data channel opened for session ${connectionId}`);
        };

        dataChannel.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                const conn = connections.get(connectionId);
                if (msg.type === 'frame' && conn && conn.processor) {
                    conn.processor.enqueueFrame(msg);
                }
            } catch (e) {
                console.warn('Failed to parse data channel message', e);
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                if (connections.has(connectionId)) connections.delete(connectionId);
            }
        };

        pc.ondatachannel = (event) => {
            console.log('Peer opened a data channel:', event.channel.label);
        };

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Store connection
        connections.set(connectionId, {
            pc,
            dataChannel,
            createdAt: Date.now(),
            processor: (new ASLSessionProcessor(connectionId))
        });

        // attach processor connection id for sending results
        const connObj = connections.get(connectionId);
        connObj.processor.connectionId = connectionId;

        res.json({ sdp: pc.localDescription.sdp, session_id: connectionId });
    } catch (error) {
        console.error('Error handling /offer:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/asl/sessions', (req, res) => {
    const list = [];
    for (const [k, v] of connections.entries()) {
        list.push({ session_id: k, createdAt: v.createdAt });
    }
    res.json({ sessions: list });
});

// Admin: reset sessions
app.post('/asl/reset', (req, res) => {
    connections.clear();
    res.json({ ok: true, message: 'All I3D sessions reset' });
});

const startServer = async () => {
    console.log('Checking microservice connections...');
    const i3dHealth = await checkMicroserviceHealth(I3D_SERVICE_URL, 'I3D Service');

    if (i3dHealth) {
        console.log('I3D microservice is connected and healthy');
    } else {
        console.log('I3D microservice is not available - will retry during operation');
    }

    app.listen(PORT, () => {
        console.log(`Gateway server running on port ${PORT}`);
        console.log(`I3D Service URL: ${I3D_SERVICE_URL}`);
        console.log(`Active connections: ${connections.size}`);
        console.log(`Ready for ASL recognition!`);
    });
};

startServer();

export default app;

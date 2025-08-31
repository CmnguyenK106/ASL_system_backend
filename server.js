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

// Serve static files (for your HTML/CSS/JS)
app.use(express.static('.'));

// Configuration
const PORT = process.env.PORT || 8008;
const ASL_SERVICE_URL = process.env.ASL_SERVICE_URL || 'http://localhost:5000';
const ASL_API_KEY = process.env.ASL_API_KEY || '';
const FRAME_QUEUE_SIZE = parseInt(process.env.FRAME_QUEUE_SIZE) || 5;
const PROCESSING_TIMEOUT = parseInt(process.env.PROCESSING_TIMEOUT) || 10000;
const ASL_PROCESSING_INTERVAL = parseInt(process.env.ASL_PROCESSING_INTERVAL) || 200;

// Local development flag
const IS_LOCAL = process.env.NODE_ENV !== 'production';

console.log('Configuration:');
console.log(`   Port: ${PORT}`);
console.log(`   ASL Service URL: ${ASL_SERVICE_URL}`);
console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`   Local development: ${IS_LOCAL}`);

// Store active connections and frame processing queues
const connections = new Map();
const processingQueues = new Map();
const userSessions = new Map(); // Track ASL sessions per user

// ASL-specific Frame processing queue class
class ASLFrameProcessor {
    constructor(connectionId, userId = null) {
        this.connectionId = connectionId;
        this.userId = userId || `conn_${connectionId}`;
        this.queue = [];
        this.processing = false;
        this.lastProcessedTime = Date.now();
        this.frameCounter = 0;
        this.lastRecognition = '';
        this.recognitionSequence = [];
    }
    
    async addFrame(frameData) {
        // Limit queue size for ASL (don't need as many frames buffered)
        if (this.queue.length >= FRAME_QUEUE_SIZE) {
            this.queue.shift(); // Remove oldest frame
        }
        
        this.queue.push({
            data: frameData,
            timestamp: Date.now()
        });
        
        if (!this.processing) {
            this.processQueue();
        }
    }
    
    async processQueue() {
        this.processing = true;
        
        while (this.queue.length > 0) {
            const frame = this.queue.shift();
            
            try {
                // Skip frame if too old (ASL needs fresher frames)
                if (Date.now() - frame.timestamp > 1000) {
                    continue;
                }
                
                this.frameCounter++;
                const result = await this.callASLMicroservice(frame.data);
                
                // Send result back to client
                const connection = connections.get(this.connectionId);
                if (connection && connection.dataChannel && 
                    connection.dataChannel.readyState === 'open') {
                    
                    // Format result for client
                    const clientResult = this.formatASLResult(result);
                    connection.dataChannel.send(JSON.stringify(clientResult));
                }
                
                this.lastProcessedTime = Date.now();
                
                // ASL processing interval (don't overwhelm the microservice)
                await new Promise(resolve => setTimeout(resolve, ASL_PROCESSING_INTERVAL));
                
            } catch (error) {
                console.error(`ASL processing error for connection ${this.connectionId}:`, error);
                
                // Send error message to client
                const connection = connections.get(this.connectionId);
                if (connection && connection.dataChannel && 
                    connection.dataChannel.readyState === 'open') {
                    connection.dataChannel.send(JSON.stringify({
                        type: 'asl_result',
                        text: 'ASL processing temporarily unavailable',
                        recognition: null,
                        confidence: 0.0,
                        error: true,
                        timestamp: new Date().toISOString()
                    }));
                }
            }
        }
        
        this.processing = false;
    }
    
    async callASLMicroservice(base64FrameData) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PROCESSING_TIMEOUT);
        
        try {
            const headers = {
                'Content-Type': 'application/json'
            };
            
            if (ASL_API_KEY) {
                headers['Authorization'] = `Bearer ${ASL_API_KEY}`;
            }

            // Prepare payload for ASL microservice
            const payload = {
                session_id: this.userId,
                frame: base64FrameData
            };

            console.log(`Sending frame to ASL microservice: ${ASL_SERVICE_URL}/process_frame`);

            const response = await fetch(`${ASL_SERVICE_URL}/process_frame`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ASL microservice returned ${response.status}: ${errorText}`);
            }

            const result = await response.json();
            return result;
            
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                console.error('ASL microservice request timeout');
                return { 
                    session_id: this.userId,
                    recognition: null,
                    current_gloss: '',
                    error: 'timeout',
                    timestamp: new Date().toISOString()
                };
            }
            
            console.error('ASL microservice call failed:', error);
            throw error;
        }
    }
    
    formatASLResult(aslResponse) {
        // Track recognition sequence
        if (aslResponse.recognition && aslResponse.recognition !== this.lastRecognition) {
            this.recognitionSequence.push({
                word: aslResponse.recognition,
                timestamp: new Date().toISOString()
            });
            this.lastRecognition = aslResponse.recognition;
            
            // Keep only last 20 recognitions
            if (this.recognitionSequence.length > 20) {
                this.recognitionSequence = this.recognitionSequence.slice(-20);
            }
        }
        
        return {
            type: 'asl_result',
            // New word recognized (only when new gesture detected)
            recognition: aslResponse.recognition || null,
            // Currently active gesture
            current_gloss: aslResponse.current_gloss || '',
            // Full sentence so far
            sentence: this.recognitionSequence.map(item => item.word).join(' '),
            // Processing status
            buffer_size: aslResponse.buffer_size || 0,
            frame_counter: aslResponse.frame_counter || this.frameCounter,
            session_id: aslResponse.session_id || this.userId,
            // Display text for UI
            text: this.formatDisplayText(aslResponse),
            confidence: this.calculateConfidence(aslResponse),
            timestamp: aslResponse.timestamp || new Date().toISOString(),
            error: aslResponse.error || false
        };
    }
    
    formatDisplayText(aslResponse) {
        const currentGloss = aslResponse.current_gloss || '';
        const sentence = this.recognitionSequence.map(item => item.word).join(' ');
        
        if (currentGloss && sentence) {
            return `${sentence} [${currentGloss}]`;
        } else if (currentGloss) {
            return `[${currentGloss}]`;
        } else if (sentence) {
            return sentence;
        } else {
            return 'Ready for ASL recognition...';
        }
    }
    
    calculateConfidence(aslResponse) {
        // Simple confidence calculation based on buffer status
        const bufferSize = aslResponse.buffer_size || 0;
        const maxBuffer = 64; // From your ASL config
        
        if (aslResponse.recognition) {
            return 0.9; // High confidence for recognized words
        } else if (aslResponse.current_gloss) {
            return 0.7; // Medium confidence for active gesture
        } else if (bufferSize > maxBuffer * 0.5) {
            return 0.3; // Low confidence when building buffer
        } else {
            return 0.1; // Very low confidence
        }
    }
    
    async resetSession() {
        try {
            const headers = {
                'Content-Type': 'application/json'
            };
            
            if (ASL_API_KEY) {
                headers['Authorization'] = `Bearer ${ASL_API_KEY}`;
            }
            
            const response = await fetch(`${ASL_SERVICE_URL}/reset_session`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    session_id: this.userId
                })
            });
            
            if (response.ok) {
                this.recognitionSequence = [];
                this.lastRecognition = '';
                console.log(`Reset ASL session for user: ${this.userId}`);
            }
            
            return response.ok;
        } catch (error) {
            console.error('Failed to reset ASL session:', error);
            return false;
        }
    }
}

// Health check for ASL microservice
async function checkASLMicroserviceHealth() {
    try {
        const headers = {};
        if (ASL_API_KEY) {
            headers['Authorization'] = `Bearer ${ASL_API_KEY}`;
        }
        
        const response = await fetch(`${ASL_SERVICE_URL}/health`, {
            method: 'GET',
            headers
        });
        
        if (response.ok) {
            const health = await response.json();
            console.log('ASL Microservice Health:', health);
            return health;
        }
        
        return false;
    } catch (error) {
        console.error('ASL microservice health check failed:', error);
        return false;
    }
}

// WebRTC offer endpoint
app.post('/offer', async (req, res) => {
    try {
        const { sdp, type, userId } = req.body;
        
        if (!sdp || type !== 'offer') {
            return res.status(400).json({ error: 'Invalid SDP offer' });
        }

        console.log('Received WebRTC offer from client', userId ? `(User: ${userId})` : '');

        // Create peer connection for this client
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });

        const connectionId = Date.now() + Math.random();
        const finalUserId = userId || `user_${connectionId}`;
        
        connections.set(connectionId, { 
            pc, 
            dataChannel: null, 
            userId: finalUserId 
        });

        // Create ASL frame processor for this connection
        const aslProcessor = new ASLFrameProcessor(connectionId, finalUserId);
        processingQueues.set(connectionId, aslProcessor);

        // Handle incoming data channel from client
        pc.ondatachannel = (event) => {
            const channel = event.channel;
            console.log('Received data channel:', channel.label);
            
            connections.get(connectionId).dataChannel = channel;
            
            channel.onopen = () => {
                console.log(`Data channel opened with client (User: ${finalUserId})`);
                // Send welcome message with ASL-specific info
                channel.send(JSON.stringify({
                    type: 'system',
                    text: 'Connected to ASL Recognition! Start signing to see results.',
                    confidence: 1.0,
                    asl_ready: true,
                    session_id: finalUserId
                }));
            };
            
            channel.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'frame' && data.data) {
                        // Add frame to ASL processing queue
                        await aslProcessor.addFrame(data.data);
                    } else if (data.type === 'reset_asl') {
                        // Reset ASL session
                        const resetSuccess = await aslProcessor.resetSession();
                        channel.send(JSON.stringify({
                            type: 'system',
                            text: resetSuccess ? 'ASL session reset successfully' : 'Failed to reset ASL session',
                            confidence: 1.0,
                            session_reset: resetSuccess
                        }));
                    } else if (data.type === 'get_sentence') {
                        // Send current recognized sentence
                        channel.send(JSON.stringify({
                            type: 'sentence',
                            text: aslProcessor.recognitionSequence.map(item => item.word).join(' '),
                            sequence: aslProcessor.recognitionSequence,
                            confidence: 1.0
                        }));
                    }
                } catch (error) {
                    console.error('Error processing client message:', error);
                    if (channel.readyState === 'open') {
                        channel.send(JSON.stringify({
                            type: 'error',
                            text: 'Failed to process request',
                            confidence: 0.0,
                            error: true
                        }));
                    }
                }
            };
            
            channel.onclose = () => {
                console.log(`Data channel closed for user: ${finalUserId}`);
                connections.delete(connectionId);
                processingQueues.delete(connectionId);
            };
        };

        // Handle incoming video track
        pc.ontrack = (event) => {
            console.log(`Received video track from client (User: ${finalUserId})`);
            // For ASL, we process frames via data channel for better control
        };

        // Handle connection state changes
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE connection state for ${finalUserId}: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                connections.delete(connectionId);
                processingQueues.delete(connectionId);
                try { pc.close(); } catch (e) {}
            }
        };

        // Set remote description and create answer
        await pc.setRemoteDescription(new RTCSessionDescription({ type, sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Return answer to client
        res.json({
            sdp: pc.localDescription.sdp,
            type: pc.localDescription.type,
            session_id: finalUserId
        });

        console.log(`WebRTC handshake completed for user: ${finalUserId}`);

    } catch (error) {
        console.error('WebRTC setup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ASL-specific endpoints
app.post('/asl/reset-session', async (req, res) => {
    try {
        const { userId, connectionId } = req.body;
        
        let processor = null;
        
        if (connectionId && processingQueues.has(connectionId)) {
            processor = processingQueues.get(connectionId);
        } else if (userId) {
            // Find processor by userId
            for (const [id, proc] of processingQueues) {
                if (proc.userId === userId) {
                    processor = proc;
                    break;
                }
            }
        }
        
        if (processor) {
            const success = await processor.resetSession();
            res.json({ success, message: success ? 'Session reset' : 'Reset failed' });
        } else {
            res.status(404).json({ error: 'Session not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/asl/sessions', (req, res) => {
    const sessions = [];
    for (const [connectionId, processor] of processingQueues) {
        sessions.push({
            connectionId,
            userId: processor.userId,
            frameCounter: processor.frameCounter,
            recognitionCount: processor.recognitionSequence.length,
            lastProcessed: processor.lastProcessedTime,
            currentSentence: processor.recognitionSequence.map(item => item.word).join(' ')
        });
    }
    
    res.json({
        activeSessions: sessions.length,
        sessions
    });
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const aslHealth = await checkASLMicroserviceHealth();
    
    res.json({ 
        status: 'healthy',
        connections: connections.size,
        processingQueues: processingQueues.size,
        aslMicroservice: aslHealth,
        config: {
            aslServiceUrl: ASL_SERVICE_URL,
            frameQueueSize: FRAME_QUEUE_SIZE,
            processingTimeout: PROCESSING_TIMEOUT,
            processingInterval: ASL_PROCESSING_INTERVAL
        },
        timestamp: new Date().toISOString()
    });
});

// Test endpoint for ASL microservice
app.post('/test-asl', async (req, res) => {
    try {
        const { image, userId } = req.body;
        
        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }
        
        const testUserId = userId || 'test_user';
        const processor = new ASLFrameProcessor('test', testUserId);
        
        const result = await processor.callASLMicroservice(image);
        const formattedResult = processor.formatASLResult(result);
        
        res.json(formattedResult);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get microservice status
app.get('/asl/microservice-status', async (req, res) => {
    try {
        const health = await checkASLMicroserviceHealth();
        res.json({
            connected: !!health,
            health,
            url: ASL_SERVICE_URL
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gateway...');
    
    // Reset all ASL sessions
    const resetPromises = [];
    for (const [id, processor] of processingQueues) {
        resetPromises.push(processor.resetSession());
    }
    
    try {
        await Promise.all(resetPromises);
        console.log('All ASL sessions reset');
    } catch (error) {
        console.error('Error resetting ASL sessions:', error);
    }
    
    // Close all peer connections
    for (const [id, conn] of connections) {
        try {
            if (conn.dataChannel) conn.dataChannel.close();
            if (conn.pc) conn.pc.close();
        } catch (e) {
            console.error('Error closing connection:', e);
        }
    }
    
    connections.clear();
    processingQueues.clear();
    process.exit(0);
});

// Initialize server
const startServer = async () => {
    // Check ASL microservice on startup
    console.log('Checking ASL microservice connection...');
    const aslHealth = await checkASLMicroserviceHealth();
    
    if (aslHealth) {
        console.log('ASL microservice is connected and healthy');
    } else {
        console.log('ASL microservice is not available - will retry during operation');
    }
    
    app.listen(PORT, () => {
        console.log(`Gateway server running on port ${PORT}`);
        console.log(`ASL Service URL: ${ASL_SERVICE_URL}`);
        console.log(`Active connections: ${connections.size}`);
        console.log(`Ready for ASL recognition!`);
    });
};

startServer();

export default app;
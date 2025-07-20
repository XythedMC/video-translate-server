const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const speech = require('@google-cloud/speech').v1p1beta1;
const { TranslationServiceClient } = require('@google-cloud/translate').v3beta1;

const logWithTimestamp = (identifier, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${identifier}] ${message}`, ...args);
};

let credentialsConfig = {};

const projectId = 'dazzling-byway-356015';
const location = 'global';

const base64Credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64;

if (base64Credentials) {
    try {
        const credentialsJson = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const parsedCredentials = JSON.parse(credentialsJson);
        credentialsConfig = { credentials: parsedCredentials };
        logWithTimestamp('GCP Setup', 'Google Cloud clients will be initialized using Base64 encoded service account.');
    } catch (error) {
        console.error('Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64:', error);
    }
} else {
    logWithTimestamp('GCP Setup', 'GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64 not found. Using default credentials.');
}

const speechClient = new speech.SpeechClient(credentialsConfig);
const translationClient = new TranslationServiceClient(credentialsConfig);

const app = express();
const server = http.createServer(app);

// --- NEW: Simplified CORS for easier local development ---
// This allows connections from any origin. For production, you should restrict this
// to your actual domain (e.g., 'https://video-translator.netlify.app').
const corsOptions = {
    origin: "*",
};

app.use(cors(corsOptions));
const io = socketIo(server, {
    cors: corsOptions,
    maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 5000;

const STT_STREAM_TIMEOUT_MS = 4 * 60 * 1000;

const activeSpeechStreams = new Map();
const userLanguages = new Map();
const usernameToSocketId = new Map();
const socketIdToUsername = new Map();
const activeCalls = new Map();

const broadcastOnlineUsers = () => {
    const onlineUsers = Array.from(usernameToSocketId.keys());
    io.emit('updateOnlineUsers', onlineUsers);
    logWithTimestamp('Broadcast', `Sent online users list: [${onlineUsers.join(', ')}]`);
};

io.on('connection', (socket) => {
    // This log should now appear in your server console when a client connects.
    logWithTimestamp(socket.id, 'A user connected. Waiting for registration...');

    socket.on('registerUsername', (username) => {
        if (usernameToSocketId.has(username)) {
            logWithTimestamp(username, `Registration FAILED: Username taken.`);
            socket.emit('registrationFailed', `Username "${username}" is already taken.`);
            return;
        }
        usernameToSocketId.set(username, socket.id);
        socketIdToUsername.set(socket.id, username);
        userLanguages.set(socket.id, { 
            targetLanguage: 'es', 
            sttSourceLanguages: ['en-US', 'he-IL', 'ru-RU'] 
        });
        socket.emit('registrationSuccess', username);
        logWithTimestamp(username, `Registered successfully.`);
        
        broadcastOnlineUsers();
    });

    socket.on('outgoingCall', (data) => {
        const { userToCall, signalData } = data;
        const callerUsername = socketIdToUsername.get(socket.id);
        if (!callerUsername) return;

        const calleeSocketId = usernameToSocketId.get(userToCall);
        if (calleeSocketId) {
            // Only log the initial offer, not every ICE candidate
            if (signalData.type === 'offer') {
                logWithTimestamp(callerUsername, `Initiating call to '${userToCall}'.`);
                logWithTimestamp(userToCall, `Received incoming call from '${callerUsername}'.`);
            }
            // Use a new, specific event name to send to the receiver
            io.to(calleeSocketId).emit('incomingCall', { from: callerUsername, signalData });
        } else {
            logWithTimestamp(callerUsername, `Call FAILED: User '${userToCall}' not found.`);
            socket.emit('callFailed', { user: userToCall });
        }
    });

    socket.on('answerCall', (data) => {
        const { signal, to } = data;
        const calleeUsername = socketIdToUsername.get(socket.id);
        if (!calleeUsername) return;
        const callerSocketId = usernameToSocketId.get(to);
        if (callerSocketId) {
            logWithTimestamp(calleeUsername, `Sending call acceptance to '${to}'.`);
            io.to(callerSocketId).emit('callAccepted', { signal, from: calleeUsername });
            activeCalls.set(callerSocketId, calleeUsername);
            activeCalls.set(socket.id, to);
            logWithTimestamp('Call Tracking', `Call active between ${to} and ${calleeUsername}.`);
        } else {
            logWithTimestamp(calleeUsername, `Failed to find caller '${to}' for call acceptance.`);
        }
    });

    socket.on('updateLanguageSettings', (data) => {
        const { targetLanguage, sttSourceLanguages } = data;
        userLanguages.set(socket.id, { targetLanguage, sttSourceLanguages });
    });

    // Track timeouts for each socket to avoid multiple listeners
    const socketTimeouts = new Map();

            socket.on('audioChunk', (data) => {
            const { chunk, sampleRate } = data;
            const socketId = socket.id;
            const username = socketIdToUsername.get(socketId);
            const currentUserLangs = userLanguages.get(socketId);
            
            // Only log audio chunks occasionally to reduce spam
            if (Math.random() < 0.01) { // Log ~1% of audio chunks
                logWithTimestamp(username || socketId, `Received audio chunk: ${chunk?.byteLength || 0} bytes`);
            }
            
            if (!currentUserLangs || !username || !chunk || chunk.byteLength === 0) {
                return;
            }
            
            // Only process audio if user is in an active call
            const isInCall = activeCalls.has(socketId);
            if (!isInCall) {
                return;
            }

        if (!activeSpeechStreams.has(socketId)) {
            logWithTimestamp(username, `Creating new STT stream with Auto Language-ID.`);
            const sourceLanguages = currentUserLangs.sttSourceLanguages;

            if (!sourceLanguages || sourceLanguages.length === 0) {
                logWithTimestamp(username, 'STT Error: No source languages provided.');
                return;
            }

            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: sampleRate,
                    // The API requires a primary language code.
                    languageCode: sourceLanguages[0],
                    // The rest of the list are the "additional" alternative codes.
                    alternativeLanguageCodes: sourceLanguages.slice(1),
                    //model: 'telephony',
                    enableAutomaticPunctuation: true,
                    interimResults: true,
                },
            };

            const recognizeStream = speechClient.streamingRecognize(request)
                .on('error', (err) => {
                    logWithTimestamp(username, `STT Error:`, err);
                    activeSpeechStreams.delete(socketId);
                    const timeout = socketTimeouts.get(socketId);
                    if (timeout) {
                        clearTimeout(timeout);
                        socketTimeouts.delete(socketId);
                    }
                })
                .on('data', async (streamData) => {
                    const result = streamData.results[0];
                    if (!result || !result.alternatives[0]) return;

                    const { transcript } = result.alternatives[0];
                    const { isFinal } = result;
                    const detectedLanguageCode = result.languageCode; 
                    const speakerUsername = socketIdToUsername.get(socket.id);
                    if (!speakerUsername) return;

                    socket.emit('liveSubtitle', { speakerId: speakerUsername, text: transcript, isFinal });

                    const remoteUsername = activeCalls.get(socket.id);
                    const remoteSocketId = usernameToSocketId.get(remoteUsername);
                    if (!remoteSocketId) return;

                    const remoteLangs = userLanguages.get(remoteSocketId);
                    if (!remoteLangs) return;

                    if (isFinal) {
                        const needsTranslation = transcript && remoteLangs.targetLanguage && detectedLanguageCode.split('-')[0] !== remoteLangs.targetLanguage.split('-')[0];
                        if (needsTranslation) {
                            try {
                                const [response] = await translationClient.translateText({
                                    parent: `projects/${projectId}/locations/${location}`,
                                    contents: [transcript],
                                    sourceLanguageCode: detectedLanguageCode.split('-')[0],
                                    targetLanguageCode: remoteLangs.targetLanguage.split('-')[0],
                                });
                                io.to(remoteSocketId).emit('liveSubtitle', { speakerId: speakerUsername, text: response.translations[0].translatedText, isFinal: true });
                            } catch (translateErr) {
                                logWithTimestamp(speakerUsername, `Translation Error:`, translateErr);
                                io.to(remoteSocketId).emit('liveSubtitle', { speakerId: speakerUsername, text: transcript, isFinal: true });
                            }
                        } else {
                            io.to(remoteSocketId).emit('liveSubtitle', { speakerId: speakerUsername, text: transcript, isFinal: true });
                        }
                    } else {
                        io.to(remoteSocketId).emit('liveSubtitle', { speakerId: speakerUsername, text: transcript, isFinal: false });
                    }
                });

            activeSpeechStreams.set(socketId, recognizeStream);

            const streamDestroyTimeout = setTimeout(() => {
                if (recognizeStream && !recognizeStream.destroyed) {
                    recognizeStream.destroy();
                }
                activeSpeechStreams.delete(socketId);
                socketTimeouts.delete(socketId);
            }, STT_STREAM_TIMEOUT_MS);

            socketTimeouts.set(socketId, streamDestroyTimeout);
        }
        
        const stream = activeSpeechStreams.get(socketId);
        if (stream && !stream.destroyed) {
            stream.write(Buffer.from(chunk));
        }
    });

    const handleDisconnect = () => {
        const socketId = socket.id;
        const username = socketIdToUsername.get(socketId);
        if (!username) {
            logWithTimestamp(socketId, 'Anonymous user disconnecting');
            return;
        }

        logWithTimestamp(username, 'User is disconnecting. Reason: ' + (socket.disconnectReason || 'unknown'));
        const peerUsername = activeCalls.get(socketId);
        if (peerUsername) {
            const peerSocketId = usernameToSocketId.get(peerUsername);
            if (peerSocketId) {
                io.to(peerSocketId).emit('peerDisconnected');
                activeCalls.delete(peerSocketId);
            }
        }

        if (activeSpeechStreams.has(socketId)) {
            activeSpeechStreams.get(socketId).destroy();
            activeSpeechStreams.delete(socketId);
        }

        // Clean up timeout
        const timeout = socketTimeouts.get(socketId);
        if (timeout) {
            clearTimeout(timeout);
            socketTimeouts.delete(socketId);
        }

        usernameToSocketId.delete(username);
        socketIdToUsername.delete(socketId);
        userLanguages.delete(socketId);
        activeCalls.delete(socketId);
        logWithTimestamp(username, 'Cleanup complete.');
        
        broadcastOnlineUsers();
    };

    socket.on('disconnectCall', handleDisconnect);
    socket.on('disconnect', handleDisconnect);
});

server.listen(PORT, () => console.log(`🚀 Signaling server listening on port ${PORT}`));

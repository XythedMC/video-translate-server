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

const speechClient = new speech.SpeechClient();
const translationClient = new TranslationServiceClient();

// --- CRITICAL: Ensure this projectId matches your Google Cloud Project ID ---
const projectId = 'dazzling-byway-356015'; // Your Google Cloud Project ID
const location = 'global'; // Or your specific region for Translation API

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: 'http://localhost:3000' }));

const io = socketIo(server, {
    cors: {
        origin: 'http://localhost:3000',
        methods: ['GET', 'POST']
    },
    maxHttpBufferSize: 1e8 // Increased buffer size
});

const PORT = process.env.PORT || 5000;

const activeSpeechStreams = new Map();
const userLanguages = new Map();
const usernameToSocketId = new Map();
const socketIdToUsername = new Map();
const activeCalls = new Map();

io.on('connection', (socket) => {
    logWithTimestamp(socket.id, 'A user connected.');

    socket.on('registerUsername', (username) => {
        if (usernameToSocketId.has(username)) {
            socket.emit('registrationFailed', `Username "${username}" is already taken.`);
            return;
        }
        usernameToSocketId.set(username, socket.id);
        socketIdToUsername.set(socket.id, username);
        // ...existing code...
        userLanguages.set(socket.id, { 
            sourceLanguage: 'en-US', 
            targetLanguage: 'es', 
            sttSourceLanguages: ['en-US', 'he-IL'] 
        });
        // ...existing code...
        socket.emit('registrationSuccess', username);
        logWithTimestamp(username, `Registered successfully.`);
    });

    socket.on('callUser', (data) => {
        const { userToCall, signalData } = data;
        const callerUsername = socketIdToUsername.get(socket.id);
        if (!callerUsername) return;
        const calleeSocketId = usernameToSocketId.get(userToCall);
        if (calleeSocketId) {
            io.to(calleeSocketId).emit('callUser', { from: callerUsername, signalData });
        } else {
            socket.emit('callFailed', { message: `User ${userToCall} is not online.` });
        }
    });

    socket.on('answerCall', (data) => {
        const { signal, to } = data;
        const calleeUsername = socketIdToUsername.get(socket.id);
        if (!calleeUsername) return;
        const callerSocketId = usernameToSocketId.get(to);
        if (callerSocketId) {
            io.to(callerSocketId).emit('callAccepted', { signal, from: calleeUsername });
            activeCalls.set(callerSocketId, calleeUsername);
            activeCalls.set(socket.id, to);
            logWithTimestamp('Call Tracking', `Call established between ${to} and ${calleeUsername}.`);
        }
    });

    socket.on('updateLanguageSettings', (data) => {
        const socketId = socket.id;
        const username = socketIdToUsername.get(socketId) || socketId;
        const currentLangs = userLanguages.get(socketId) || {};
        const { sourceLanguage, targetLanguage, sttSourceLanguages } = data;
        const settingsChanged = currentLangs.source !== sourceLanguage || JSON.stringify(currentLangs.sttSourceLanguages) !== JSON.stringify(sttSourceLanguages);
        userLanguages.set(socketId, { sourceLanguage, targetLanguage, sttSourceLanguages });
        if (settingsChanged && activeSpeechStreams.has(socketId)) {
            logWithTimestamp(username, `Restarting STT stream due to language change.`);
            activeSpeechStreams.get(socketId).destroy();
            activeSpeechStreams.delete(socketId);
        }
    });

    socket.on('audioChunk', (data) => {
        const { chunk, sampleRate } = data;
        const socketId = socket.id;
        const username = socketIdToUsername.get(socketId);
        const currentLangs = userLanguages.get(socketId);
        if (!currentLangs || !username) return;

        // CRITICAL FIX: Do not process empty chunks
        if (!chunk || chunk.byteLength === 0) {
            return;
        }

        if (!activeSpeechStreams.has(socketId)) {
            logWithTimestamp(username, `Creating new STT stream with sample rate: ${sampleRate}`);
            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: sampleRate,
                    languageCode: currentLangs.sourceLanguage,
                    // Use alternativeLanguageCodes for multi-language recognition
                    alternativeLanguageCodes: currentLangs.sttSourceLanguages.filter(lang => lang !== currentLangs.sourceLanguage),
                    model: 'default',
                    interimResults: true,
                },
            };
            const recognizeStream = speechClient.streamingRecognize(request)
                .on('error', (err) => {
                    // --- ENHANCED ERROR LOGGING ---
                    logWithTimestamp(username, `STT Error:`, err); // Log the full error object
                    if (err.code === 16) { // UNAUTHENTICATED
                         logWithTimestamp(username, `STT Authentication Error: Please check GOOGLE_APPLICATION_CREDENTIALS and service account permissions.`);
                    } else if (err.code === 7) { // PERMISSION_DENIED
                         logWithTimestamp(username, `STT Permission Denied: Ensure Speech-to-Text API is enabled and service account has 'Speech-to-Text User' role.`);
                    }
                    // --- END ENHANCED ERROR LOGGING ---
                    activeSpeechStreams.delete(socketId);
                })
                .on('data', async (streamData) => {
                    const result = streamData.results[0];
                    if (!result || !result.alternatives[0]) return;
                    const { transcript } = result.alternatives[0];
                    const { isFinal } = result;
                    let translatedText = transcript;
                    if (
                        isFinal &&
                        transcript && // <-- Only translate if transcript is not empty
                        currentLangs.targetLanguage &&
                        currentLangs.sourceLanguage.split('-')[0] !== currentLangs.targetLanguage.split('-')[0]
                    ) {
                        try {
                            const [response] = await translationClient.translateText({
                                parent: `projects/${projectId}/locations/${location}`,
                                contents: [transcript],
                                sourceLanguageCode: currentLangs.sourceLanguage.split('-')[0],
                                targetLanguageCode: currentLangs.targetLanguage.split('-')[0],
                            });
                            translatedText = response.translations[0].translatedText;
                        } catch (translateErr) {
                            logWithTimestamp(username, `Translation Error:`, translateErr);
                            if (translateErr.code === 7) {
                                logWithTimestamp(username, `Translation Permission Denied: Ensure Translation API is enabled and service account has 'Cloud Translation API User' role.`);
                            }
                        }
                    }
                    io.emit('liveSubtitle', { speakerId: username, text: translatedText, isFinal });
                });
            activeSpeechStreams.set(socketId, recognizeStream);
        }
        
        const stream = activeSpeechStreams.get(socketId);
        if (stream && !stream.destroyed) {
            stream.write(Buffer.from(chunk));
        }
    });

    const handleDisconnect = () => {
        const socketId = socket.id;
        const username = socketIdToUsername.get(socketId);
        if (!username) return;

        logWithTimestamp(username, 'User is disconnecting.');
        const peerUsername = activeCalls.get(socketId);
        if (peerUsername) {
            const peerSocketId = usernameToSocketId.get(peerUsername);
            if (peerSocketId) {
                io.to(peerSocketId).emit('peerDisconnected');
                activeCalls.delete(peerSocketId);
            }
        }

        if (activeSpeechStreams.has(socketId)) {
            const stream = activeSpeechStreams.get(socketId);
            stream.destroy(); 
            activeSpeechStreams.delete(socketId);
        }
        usernameToSocketId.delete(username);
        socketIdToUsername.delete(socketId);
        userLanguages.delete(socketId);
        activeCalls.delete(socketId);
        logWithTimestamp(username, 'Cleanup complete.');
    };

    socket.on('disconnectCall', handleDisconnect);
    socket.on('disconnect', handleDisconnect);
});

server.listen(PORT, () => console.log(`🚀 Signaling server listening on port ${PORT}`));

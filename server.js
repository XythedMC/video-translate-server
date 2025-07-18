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

let credentialsConfig = {}; // Object to hold the credentials configuration for clients

const projectId = 'dazzling-byway-356015'; // Your Google Cloud Project ID
const location = 'global'; // For Translation API

const base64Credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64;

if (base64Credentials) {
    try {
        const credentialsJson = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const parsedCredentials = JSON.parse(credentialsJson); // Parse the credentials JSON

        credentialsConfig = { credentials: parsedCredentials };
        logWithTimestamp('GCP Setup', 'Google Cloud clients will be initialized using Base64 encoded service account.');
    } catch (error) {
        console.error('Failed to parse or use Base64 encoded GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64:', error);
    }
} else {
    logWithTimestamp('GCP Setup', 'GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64 not found. Google Cloud clients will attempt default environment credentials.');
}

const speechClient = new speech.SpeechClient(credentialsConfig);
const translationClient = new TranslationServiceClient(credentialsConfig);

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
    'https://video-translator.netlify.app',
    'http://localhost:3000', // For local React dev server
    'http://localhost:5173', // For local Vite dev server
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
};

app.use(cors(corsOptions));
const io = socketIo(server, {
    cors: corsOptions,
    maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 5000;

// --- NEW: STT Stream Timeout for long calls (4 minutes = 240,000 ms) ---
// Google Cloud STT streaming has a 5-minute limit per stream.
// We will destroy the stream proactively before it hits the limit,
// so a new one is created on the next audio chunk.
const STT_STREAM_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes in milliseconds

const activeSpeechStreams = new Map(); // Stores active STT streaming sessions
const userLanguages = new Map(); // Stores language settings for each user
const usernameToSocketId = new Map(); // Maps usernames to socket IDs
const socketIdToUsername = new Map(); // Maps socket IDs back to usernames
const activeCalls = new Map(); // Tracks active calls between users

io.on('connection', (socket) => {
    logWithTimestamp(socket.id, 'A user connected.');

    socket.on('registerUsername', (username) => {
        logWithTimestamp(username, `Attempting to register with socket ID: ${socket.id}`);
        if (usernameToSocketId.has(username)) {
            logWithTimestamp(username, `Registration FAILED: Username already taken.`);
            socket.emit('registrationFailed', `Username "${username}" is already taken.`);
            return;
        }
        usernameToSocketId.set(username, socket.id);
        socketIdToUsername.set(socket.id, username);
        userLanguages.set(socket.id, { 
            sourceLanguage: 'en-US', 
            targetLanguage: 'es', 
            sttSourceLanguages: ['en-US', 'he-IL', 'ru-RU'] 
        });
        socket.emit('registrationSuccess', username);
        logWithTimestamp(username, `Registered successfully.`);
    });

    socket.on('callUser', (data) => {
        const { userToCall, signalData } = data;
        const callerUsername = socketIdToUsername.get(socket.id);
        
        logWithTimestamp(callerUsername, `Initiating call to '${userToCall}'.`);
        if (!callerUsername) {
            logWithTimestamp(socket.id, `Call failed: Caller username not found for this socket.`);
            return;
        }

        const calleeSocketId = usernameToSocketId.get(userToCall);
        if (calleeSocketId) {
            logWithTimestamp(callerUsername, `Found '${userToCall}' online with socket ID ${calleeSocketId}. Sending offer.`);
            io.to(calleeSocketId).emit('callUser', { from: callerUsername, signalData });
        } else {
            logWithTimestamp(callerUsername, `Call FAILED: User '${userToCall}' is not online or not registered.`);
            socket.emit('callFailed', { message: `User ${userToCall} is not online.`, user: userToCall });
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

        if (!chunk || chunk.byteLength === 0) {
            return;
        }

        const remoteUsername = activeCalls.get(socketId);
        const remoteSocketId = usernameToSocketId.get(remoteUsername);
        const remoteLangs = userLanguages.get(remoteSocketId);

        if (!remoteSocketId || !remoteLangs) {
            return;
        }

        if (!activeSpeechStreams.has(socketId)) {
            logWithTimestamp(username, `Creating new STT stream with sample rate: ${sampleRate}.`);
            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: sampleRate,
                    languageCode: currentLangs.sourceLanguage,
                    alternativeLanguageCodes: currentLangs.sttSourceLanguages.filter(lang => lang !== currentLangs.sourceLanguage),
                    model: 'telephony',
                    enableAutomaticPunctuation: true,
                    interimResults: true,
                },
            };
            const recognizeStream = speechClient.streamingRecognize(request)
                .on('error', (err) => {
                    logWithTimestamp(username, `STT Error:`, err);
                    if (err.code === 16) {
                         logWithTimestamp(username, `STT Authentication Error: Please check GOOGLE_APPLICATION_CREDENTIALS and service account permissions.`);
                    } else if (err.code === 7) {
                         logWithTimestamp(username, `STT Permission Denied: Ensure Speech-to-Text API is enabled and service account has 'Speech-to-Text User' role.`);
                    }
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
                        transcript &&
                        remoteLangs.targetLanguage &&
                        currentLangs.sourceLanguage.split('-')[0] !== remoteLangs.targetLanguage.split('-')[0]
                    ) {
                        try {
                            const [response] = await translationClient.translateText({
                                parent: `projects/${projectId}/locations/${location}`,
                                contents: [transcript],
                                sourceLanguageCode: currentLangs.sourceLanguage.split('-')[0],
                                targetLanguageCode: remoteLangs.targetLanguage.split('-')[0],
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

            // --- NEW: Set a timeout to destroy the stream before its 5-minute limit ---
            // This ensures a new stream is created on the next audio chunk for long calls.
            const streamDestroyTimeout = setTimeout(() => {
                logWithTimestamp(username, `STT stream for ${username} timed out after ${STT_STREAM_TIMEOUT_MS / 1000} seconds. Renewing stream.`);
                if (recognizeStream && !recognizeStream.destroyed) {
                    recognizeStream.destroy();
                }
                activeSpeechStreams.delete(socketId); // Remove from map so a new one is created
            }, STT_STREAM_TIMEOUT_MS);

            // Store the timeout ID so we can clear it if the user disconnects earlier
            // This is a simple way; for more complex scenarios, you might manage these timeouts more robustly.
            socket.on('disconnect', () => clearTimeout(streamDestroyTimeout));
            socket.on('disconnectCall', () => clearTimeout(streamDestroyTimeout));
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
        socketIdToUsername.delete(socket.id);
        userLanguages.delete(socketId);
        activeCalls.delete(socketId);
        logWithTimestamp(username, 'Cleanup complete.');
    };

    socket.on('disconnectCall', handleDisconnect);
    socket.on('disconnect', handleDisconnect);
});

server.listen(PORT, () => console.log(`🚀 Signaling server listening on port ${PORT}`));
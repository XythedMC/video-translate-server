const speech = require('@google-cloud/speech').v1p1beta1; // Using v1p1beta1 as we tried
const fs = require('fs');
const path = require('path');

// IMPORTANT: Ensure GOOGLE_APPLICATION_CREDENTIALS environment variable is set!
// e.g., export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/service-account-key.json"

async function testSpeechToTextStreaming() {
    console.log('Attempting to initialize Google Cloud Speech-to-Text client...');
    const client = new speech.SpeechClient();

    // Configuration for the streaming request
    const request = {
        config: {
            encoding: 'LINEAR16', // Using LINEAR16 as it's the most common and robust for testing
            sampleRateHertz: 16000, // A common sample rate for LINEAR16
            languageCode: 'he-IL', // The problematic language code
            model: 'default', // You can try 'latest_long' or 'video' here too
            // interimResults: true, // Not strictly necessary for this basic test, but good practice
        },
        interimResults: true,
    };

    console.log('Creating streaming recognition stream...');
    const recognizeStream = client.streamingRecognize(request)
        .on('error', (err) => {
            console.error('Google STT Stream Error:', err);
            process.exit(1); // Exit with error code
        })
        .on('data', (data) => {
            const transcription = data.results[0]?.alternatives[0]?.transcript;
            const isFinal = data.results[0]?.isFinal;
            if (transcription) {
                console.log(`Transcription [${isFinal ? 'Final' : 'Interim'}]: "${transcription}"`);
            }
        });

    console.log('Stream created. Now sending dummy audio data...');

    // Simulate sending audio data (a few empty buffers)
    // In a real scenario, you'd pipe actual audio here.
    // For this test, we just need to trigger the stream's configuration check.
    for (let i = 0; i < 5; i++) {
        recognizeStream.write(Buffer.alloc(3200)); // Send a small empty buffer (16000Hz * 16bit/sample * 0.1s / 8 bits/byte = 3200 bytes)
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait a bit
    }

    recognizeStream.end(); // End the stream
    console.log('Dummy audio sent. Stream ended.');
}

testSpeechToTextStreaming().catch(console.error);

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import dotenv from 'dotenv';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Update the upload middleware to handle audio files
const upload = multer({
    storage: multer.diskStorage({
        destination: 'uploads/',
        filename: (req, file, cb) => {
            cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
        }
    })
});

// OpenAI client initialization
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint for Speech-to-Text
app.post('/upload', upload.single('audio'), async (req, res) => {
    console.log('Received upload request');
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
    }

    console.log('File details:', req.file);

    const filePath = req.file.path;
    const fileStream = fs.createReadStream(filePath);
    const formData = new FormData();
    formData.append('file', fileStream, {
        filename: req.file.originalname,
        contentType: req.file.mimetype
    });
    formData.append('model', 'whisper-1');

    try {
        console.log('Sending request to Whisper API...');
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            body: formData,
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                ...formData.getHeaders()
            },
        });
        
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
        }
        
        const result = await response.json();
        console.log('Transcription result:', result);
        res.json(result);
    } catch (error) {
        console.error('Error during transcription:', error);
        res.status(500).json({ error: 'Error during transcription', details: error.message });
    } finally {
        fs.unlink(filePath, (err) => {
            if (err) console.error('Failed to delete temporary file:', err);
        });
    }
});
// Endpoint for RAG
app.post('/rag', async (req, res) => {
    console.log('Received RAG request');
    console.log('Request body:', req.body);

    const { query, context } = req.body;

    if (!query) {
        console.log('Missing query');
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        console.log('Sending request to OpenAI');
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo-16k", // Using a model with higher token limit
            messages: [
                { role: "system", content: "You are a helpful assistant. Use the provided context to answer the query. If no context is provided, answer based on your general knowledge. Provide detailed and comprehensive answers." },
                { role: "user", content: `Context: ${context || 'No context provided.'}\n\nQuery: ${query}` }
            ],
            max_tokens: 1000 // Increased token limit for longer responses
        });

        console.log('Received response from OpenAI');
        res.json({ answer: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error in RAG:', error);
        res.status(500).json({ error: 'Error processing RAG request', details: error.message });
    }
});


// Endpoint for handling PDF and Word file uploads
app.post('/upload-file', upload.single('file'), async (req, res) => {
    console.log('Received file upload request');
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;

    try {
        let extractedText = ''; // Initialize empty string for extracted text

        if (req.file.mimetype === 'application/pdf') {
            // Extract text from PDF using pdf-parse
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            extractedText = data.text;
        } else if (req.file.mimetype === 'application/msword' || req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            // Extract text from Word files using mammoth
            const result = await mammoth.extractRawText({ path: filePath });
            extractedText = result.value;
        }

        // Clean up the uploaded file
        fs.unlink(filePath, (err) => {
            if (err) console.error('Failed to delete temporary file:', err);
        });

        // Send the extracted text back to the client
        res.json({ text: extractedText });
    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: 'Error processing file', details: error.message });
    }
});



// Endpoint for Text-to-Speech
app.post('/text-to-speech', async (req, res) => {
    console.log('Received text-to-speech request');
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.AZURE_SPEECH_KEY, process.env.AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput('outputAudio.wav');
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    synthesizer.speakTextAsync(
        text,
        result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                const audioPath = path.join(__dirname, 'outputAudio.wav');
                res.sendFile(audioPath, err => {
                    if (err) {
                        res.status(500).json({ error: 'Error sending the audio file' });
                    } else {
                        fs.unlink(audioPath, err => {
                            if (err) console.error('Failed to delete temporary audio file:', err);
                        });
                    }
                });
            } else {
                console.error(`Speech synthesis failed: ${result.errorDetails}`);
                res.status(500).json({ error: 'Text-to-Speech synthesis failed' });
            }
            synthesizer.close();
        },
        error => {
            console.error(error);
            res.status(500).json({ error: 'Error synthesizing speech', details: error.message });
            synthesizer.close();
        }
    );
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!', details: err.message });

  export default function handler(req, res) {
  res.status(200).json({ message: 'Hello from Vercel!' });
}
  
});

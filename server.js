import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import 'dotenv/config'; // Load environment variables from .env

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY; 
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_MONTHLY_PLAN_ID = process.env.RAZORPAY_MONTHLY_PLAN_ID;
const RAZORPAY_LIFETIME_AMOUNT = Number(process.env.RAZORPAY_LIFETIME_AMOUNT || 0);
const RAZORPAY_CURRENCY = process.env.RAZORPAY_CURRENCY || 'INR';
const RAZORPAY_SUBSCRIPTION_TOTAL_COUNT = Number(process.env.RAZORPAY_SUBSCRIPTION_TOTAL_COUNT || 120);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticRoot = path.resolve(__dirname);

// --- Middleware Setup ---
app.use(bodyParser.json());

// Serve static files for the web/PWA app
app.use(express.static(staticRoot, { extensions: ['html'] }));

// Set up CORS headers to allow requests from your front-end (assuming it's running on a different port or domain)
app.use((req, res, next) => {
    // You should restrict this origin to your front-end URL in a production environment
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// --- API Endpoint ---
app.post('/api/generate-special', async (req, res) => {
    if (!API_KEY) {
        console.error("API Key is missing in .env file.");
        return res.status(500).json({ error: "Server configuration error: API Key missing." });
    }

    // The entire payload (contents, systemInstruction, generationConfig) 
    // is passed securely from the front-end body
    const geminiPayload = req.body; 

    try {
        console.log("Proxying request to Gemini API...");
        
        const response = await fetch(`${GEMINI_API_URL}?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
        });

        if (!response.ok) {
            // Forward the non-success status code and error details
            const errorText = await response.text();
            console.error(`Gemini API Error Status: ${response.status}`, errorText);
            return res.status(response.status).json({ 
                error: "Gemini API request failed", 
                details: errorText 
            });
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Error during API proxy:", error);
        res.status(500).json({ error: "Internal server error during API call." });
    }
});

function getRazorpayAuthHeader() {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return null;
    const token = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    return `Basic ${token}`;
}

async function callRazorpayApi(endpoint, payload) {
    const authHeader = getRazorpayAuthHeader();
    if (!authHeader) {
        throw new Error("Razorpay keys are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.");
    }
    const response = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Razorpay API failed: ${response.status}`);
    }
    return response.json();
}

app.post('/api/billing/create-order', async (req, res) => {
    try {
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            return res.status(500).json({ error: "Razorpay keys missing." });
        }
        if (!RAZORPAY_LIFETIME_AMOUNT) {
            return res.status(500).json({ error: "RAZORPAY_LIFETIME_AMOUNT is not configured." });
        }
        const { restaurantId, restaurantName, email } = req.body || {};
        const payload = {
            amount: RAZORPAY_LIFETIME_AMOUNT,
            currency: RAZORPAY_CURRENCY,
            receipt: `lifetime_${restaurantId || 'guest'}_${Date.now()}`,
            payment_capture: 1,
            notes: {
                restaurantId: restaurantId || '',
                restaurantName: restaurantName || '',
                email: email || '',
                plan: 'lifetime'
            }
        };
        const order = await callRazorpayApi('orders', payload);
        res.json({
            keyId: RAZORPAY_KEY_ID,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency
        });
    } catch (error) {
        console.error("Razorpay order error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/billing/create-subscription', async (req, res) => {
    try {
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            return res.status(500).json({ error: "Razorpay keys missing." });
        }
        if (!RAZORPAY_MONTHLY_PLAN_ID) {
            return res.status(500).json({ error: "RAZORPAY_MONTHLY_PLAN_ID is not configured." });
        }
        const { restaurantId, restaurantName, email } = req.body || {};
        const payload = {
            plan_id: RAZORPAY_MONTHLY_PLAN_ID,
            total_count: RAZORPAY_SUBSCRIPTION_TOTAL_COUNT,
            quantity: 1,
            customer_notify: 1,
            notes: {
                restaurantId: restaurantId || '',
                restaurantName: restaurantName || '',
                email: email || '',
                plan: 'monthly'
            }
        };
        const subscription = await callRazorpayApi('subscriptions', payload);
        res.json({
            keyId: RAZORPAY_KEY_ID,
            subscriptionId: subscription.id,
            amount: subscription.plan_id ? undefined : null,
            currency: subscription.currency || RAZORPAY_CURRENCY
        });
    } catch (error) {
        console.error("Razorpay subscription error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/billing/verify', async (req, res) => {
    try {
        const secret = RAZORPAY_KEY_SECRET;
        if (!secret) {
            return res.status(500).json({ error: "Razorpay secret missing." });
        }
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_subscription_id,
            razorpay_signature
        } = req.body || {};

        if (!razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: "Missing payment details." });
        }

        let payload = '';
        if (razorpay_order_id) {
            payload = `${razorpay_order_id}|${razorpay_payment_id}`;
        } else if (razorpay_subscription_id) {
            payload = `${razorpay_payment_id}|${razorpay_subscription_id}`;
        } else {
            return res.status(400).json({ error: "Missing order or subscription id." });
        }

        const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        const verified = expected === razorpay_signature;

        res.json({ verified });
    } catch (error) {
        console.error("Razorpay verification error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Default route to load the app
app.get('/', (req, res) => {
    res.sendFile(path.join(staticRoot, 'index10.html'));
});

export function startServer(port = DEFAULT_PORT) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`\n==================================================`);
            console.log(`🔥 QuickServe server running on http://localhost:${port}`);
            console.log(`==================================================\n`);
            console.log(`Ready to handle requests at: POST http://localhost:${port}/api/generate-special`);
            console.log(`Gemini model: ${GEMINI_MODEL}`);
            resolve(server);
        });
        server.on('error', reject);
    });
}

const entryScript = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const isDirectRun = import.meta.url === entryScript;

if (isDirectRun) {
    startServer().catch((error) => {
        console.error("Failed to start QuickServe server:", error);
        process.exit(1);
    });
}

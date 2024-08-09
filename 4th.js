const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const schedule = require('node-schedule');
const { Metaplex } = require('@metaplex-foundation/js');
const { ENV, TokenListProvider } = require('@solana/spl-token-registry');

// Solana Wallet and RPC settings
// 341866b6-a65d-44a2-9e3b-ea0163f4458b
const apiKey = '341866b6-a65d-44a2-9e3b-ea0163f4458b'; 
const walletAddress = '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco';
// https://mainnet.helius-rpc.com/?api-key=${apiKey}
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
const checkInterval = 5000; // Check every 10 seconds
const processedTransactions = new Set(); // Set to track processed transaction signatures
const inProgress = new Set(); // Set to track if a check is already in progress
const recentlySentMessages = new Map(); // To store recently sent messages and their timestamps

// Telegram Bot settings
// 7485162316:AAFLDCICKE3eLDsHBCOlP5vo1Pxh0fLrGyE
const telegramToken = "6998914328:AAEIcRsXPklvuXh_3NTCqSFLgG4qP4RY1Z4";
// -1002173182555
const chatId = "-1002163785746";
const bot = new TelegramBot(telegramToken, { polling: true });

// Storage for token data
let tokenDataStore = {};

// Function to store token data with timestamp
function storeTokenData(tokenMint, marketCap, BagWorth, Ticker, Name, Twitter, Telegram, CreatedAt) {
    const now = Date.now();
    if (tokenDataStore[tokenMint]) {
        tokenDataStore[tokenMint].BagWorth += BagWorth;
        tokenDataStore[tokenMint].timestamps.push({ value: BagWorth, time: now });
    } else {
        tokenDataStore[tokenMint] = {
            tokenMint,
            BagWorth,
            Ticker,
            Name,
            Twitter,
            Telegram,
            CreatedAt,
            timestamps: [{ value: BagWorth, time: now }]
        };
    }
}

// Function to remove values older than one hour from BagWorth
function removeOldValues() {
    const oneHourInMs = 60 * 60 * 1000; // eine Stunde in Millisekunden
    const twoDaysInMs = 2 * 24 * 60 * 60 * 1000; // zwei Tage in Millisekunden
    const now = Date.now(); // aktuelle Zeit in Millisekunden

    for (const tokenMint in tokenDataStore) {
        const tokenData = tokenDataStore[tokenMint];

        // Check if the token is older than 2 days
        const pairCreatedAt = tokenData.CreatedAt;
        if (pairCreatedAt && (now - new Date(pairCreatedAt).getTime()) > twoDaysInMs) {
            delete tokenDataStore[tokenMint];
            continue;
        }

        if (!tokenData.timestamps) {
            tokenData.timestamps = [];
        }

        // Filter timestamps to keep only those within the last hour
        const newTimestamps = tokenData.timestamps.filter(ts => (now - ts.time) <= oneHourInMs);

        // Calculate the new BagWorth based on the filtered timestamps
        tokenData.BagWorth = newTimestamps.reduce((sum, ts) => sum + ts.value, 0);

        // Update the timestamps in the token data with the filtered list
        tokenData.timestamps = newTimestamps;

        // If no timestamps are left, remove the token from the store
        if (newTimestamps.length === 0) {
            delete tokenDataStore[tokenMint];
        }
    }
}


// Schedule a job to remove old values every 10 seconds
setInterval(removeOldValues, 10000);

async function fetchPairCreatedAt(tokenMint) {
    const targetUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
    try {
        const response = await axios.get(targetUrl);
        const data = response.data;
        return extractPairCreatedAt(data);
    } catch (error) {
        console.error('Fehler beim Abrufen von pairCreatedAt:', error);
        return null;
    }
}

function extractPairCreatedAt(data) {
    try {
        const pairs = data.pairs;
        for (const pair of pairs) {
            if (pair.dexId === 'raydium') {
                // //console.log(`Gefundene Daten für Raydium: ${JSON.stringify(pair.pairCreatedAt)}`);
                 // Debugging-Meldung
                return pair.pairCreatedAt;
            }
        }
        return null;
    } catch (error) {
        console.error(`Fehler: ${error.message}`);
        return null;
    }
}

async function getPriceChange(tokenMint) {
    const targetUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
    try {
        const response = await axios.get(targetUrl);
        const data = response.data;
        return extractPriceChange(data);
    } catch (error) {
        console.error('Fehler beim Abrufen des Price Changes:', error);
        return null;
    }
}

function extractPriceChange(data) {
    try {
        const pairs = data.pairs;
        for (const pair of pairs) {
            if (pair.dexId === 'raydium') {
                // //console.log(`Gefundene Daten für Raydium: ${JSON.stringify(pair.priceChange)}`); 
                // Debugging-Meldung
                return pair.priceChange.h24;
            }
        }
        return null;
    } catch (error) {
        return `Fehler: ${error.message}`;
    }
}

async function sendTelegramMessage(message) {
    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

async function checkTransactions() {
    try {
        inProgress.add('checking');

        const publicKey = new PublicKey(walletAddress);
        const signatures = await connection.getConfirmedSignaturesForAddress2(publicKey, { limit: 20, commitment: 'confirmed' });

        console.log(`Fetched ${signatures.length} signatures`);

        // Parallelisiere die Verarbeitung der Transaktionen
        await Promise.all(signatures.map(async (signatureInfo) => {
            const signature = signatureInfo.signature;

            if (!processedTransactions.has(signature)) {
                console.log(`Processing new transaction: ${signature}`);
                const transaction = await connection.getParsedTransaction(signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0
                });

                if (transaction) {
                    processedTransactions.add(signature);

                    const { meta, transaction: { message } } = transaction;

                    // Überprüfen, ob die Transaktion erfolgreich war
                    if (meta && meta.err === null) {
                        const accountKeys = message.accountKeys;
                        const preBalances = meta.preBalances;
                        const postBalances = meta.postBalances;

                        let solTransfers = [];
                        let tokenTransfers = [];
                        let fromAddress = 'Unknown';
                        let amountReceived = 0;

                        // SOL-Transfers analysieren
                        for (let i = 0; i < preBalances.length; i++) {
                            try {
                                fromAddress = accountKeys[i].pubkey.toBase58();
                                amountReceived = (postBalances[i] - preBalances[i]) / 1e9; // Umrechnung von Lamports in SOL
                                const solanaPrice = await getPrice('So11111111111111111111111111111111111111112'); // SOL Preis holen
                                const amountInUSD = amountReceived * solanaPrice; // Wert in USD berechnen

                                if (amountInUSD > 2000) {
                                    console.log(`Transaction ${signature} skipped because the amount exceeds $2000: $${amountInUSD.toFixed(2)}`);
                                    return; // Transaktion überspringen
                                }

                                solTransfers.push({ fromAddress, amountReceived });
                                break; // Nur den ersten SOL-Transfer berücksichtigen
                            } catch (e) {
                                console.error(`Error analyzing SOL transfer: ${e}`);
                            }
                        }

                        // SPL-Token-Transfers analysieren
                        if (meta && meta.postTokenBalances) {
                            for (const postTokenBalance of meta.postTokenBalances) {
                                const preTokenBalance = meta.preTokenBalances ? meta.preTokenBalances.find(balance => balance.mint === postTokenBalance.mint) : null;
                                if (postTokenBalance && postTokenBalance.uiTokenAmount) {
                                    const postAmount = postTokenBalance.uiTokenAmount.uiAmount;
                                    const preAmount = preTokenBalance ? preTokenBalance.uiTokenAmount.uiAmount : 0;
                                    if (postAmount > preAmount) {
                                        const tokenMint = postTokenBalance.mint;
                                        const tokenPrice = await getPrice(tokenMint);
                                        const amountReceived = postAmount - preAmount;
                                        const amountInUSD = amountReceived * tokenPrice; // Wert in USD berechnen

                                        if (amountInUSD > 2000) {
                                            console.log(`Transaction ${signature} skipped because the amount exceeds $2000: $${amountInUSD.toFixed(2)}`);
                                            return; // Transaktion überspringen
                                        }

                                        if (tokenMint !== 'So11111111111111111111111111111111111111112') {
                                            // Überprüfen, ob die erste Transaktion des Tokens älter als 2 Tage ist
                                            if (!tokenDataStore[tokenMint]?.CreatedAt) {
                                                const pairCreatedAt = await fetchPairCreatedAt(tokenMint);
                                                if (pairCreatedAt) {
                                                    tokenDataStore[tokenMint] = tokenDataStore[tokenMint] || {};
                                                    tokenDataStore[tokenMint].CreatedAt = pairCreatedAt;
                                                }
                                            }

                                            const pairCreatedAt = tokenDataStore[tokenMint]?.CreatedAt;
                                            if (pairCreatedAt && (Date.now() - new Date(pairCreatedAt).getTime()) > 2 * 24 * 60 * 60 * 1000) {
                                                console.log(`Token's first transaction is older than 2 days, skipping: ${tokenMint}`);
                                                continue;
                                            }

                                            const tokenTransferResult = await getTokenTransferMessageWithMetadata(tokenMint, amountReceived, fromAddress, signature);
                                            if (tokenTransferResult) {
                                                const { tokenTransferMessage, tokenSymbol } = tokenTransferResult;
                                                const messageKey = `${tokenSymbol}-${signature}`;

                                                if (!recentlySentMessages.has(messageKey) ||
                                                    (Date.now() - recentlySentMessages.get(messageKey)) > 60000) { // 1 Minute

                                                    tokenTransfers.push(tokenTransferMessage);
                                                    recentlySentMessages.set(messageKey, Date.now());
                                                } else {
                                                    console.log(`Duplicate message detected and skipped: ${messageKey}`);
                                                }
                                            } else {
                                                console.log(`Skipping token transfer due to missing Telegram link for token ${tokenMint}`);
                                            }
                                        }
                                    }
                                } else {
                                    console.error('Invalid token balance data');
                                }
                            }
                        }

                        if (tokenTransfers.length > 0) {
                            console.log(`Transaction Signature: ${signature}`);
                            console.log(tokenTransfers.join('\n'));
                            console.log(''); // Leere Zeile zur Trennung der Transaktionen
                            await sendTelegramMessage(tokenTransfers.join('\n'));
                        }
                    } else {
                        console.log(`Transaction ${signature} failed or has an error.`);
                    }
                }
            } else {
                console.log(`Duplicate transaction ignored: ${signature}`);
            }
        }));

    } catch (error) {
        console.error('Error fetching transactions:', error);
    } finally {
        inProgress.delete('checking');
    }
}











async function getTokenTransferMessageWithMetadata(tokenMint, amountReceived, fromAddress, signature) {
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${apiKey}`;

    try {
        if (!isValidBase58Address(tokenMint)) {
            throw new Error(`Invalid tokenMint: ${tokenMint}`);
        }

        const response = await axios.post(url, {
            mintAccounts: [tokenMint],
            includeOffChain: true,
            disableCache: false,
        }, { headers: { 'Content-Type': 'application/json' } });

        const data = response.data;
        if (!Array.isArray(data) || data.length === 0) {
            console.error("Received data is not an array or is empty:", data);
            return null;
        }

        const item = data[0];
        if (!item.offChainMetadata || !item.offChainMetadata.metadata) {
            console.error("Off-Chain Metadata not found in the response:", item);
            return null;
        }

        const offChainMetadata = item.offChainMetadata.metadata;
        const extensions = item.offChainMetadata.extensions || {};
        const Ticker = offChainMetadata.symbol || "N/A";
        const Image = offChainMetadata.image || "N/A";
        const Name = offChainMetadata.name || "N/A";
        const Twitter = offChainMetadata.twitter || extensions.twitter || "N/A";
        const Telegram = extractTelegramLink(JSON.stringify(offChainMetadata)) || "N/A";

        // Skip transactions without a Telegram link
        if (Telegram === "N/A") {
            // //console.log(`Skipping transaction for token ${tokenMint} due to missing Telegram link.`);
            return null;
        }

        const { tokenSymbol } = await getTokenMetadata(tokenMint);
        const totalSupply = await getTokenSupply(tokenMint);
        const price = await getPrice(tokenMint);
        const solanaPrice = await getPrice('So11111111111111111111111111111111111111112');

        if (totalSupply !== null && price !== null) {
            const marketCap = totalSupply * price;
            const bagWorthUSD = amountReceived * price;
            const bagWorthSolana = bagWorthUSD / solanaPrice; // Amount in SOL

            //console.log(`Price: ${price}, Amount Received: ${amountReceived}, Bag Worth USD: ${bagWorthUSD}, Bag Worth Solana: ${bagWorthSolana}`);

            storeTokenData(tokenMint, marketCap, bagWorthUSD, Ticker, Name, Twitter, Telegram);
            const tokenTransferMessage = await formatMessage(fromAddress, tokenMint, amountReceived, marketCap, bagWorthUSD, bagWorthSolana, Ticker, tokenSymbol, Twitter, Telegram, signature, Image);
            return { tokenTransferMessage, tokenSymbol };
        } else {
            return null;
        }
    } catch (error) {
        console.error("Error fetching metadata or calculating values:", error);
        return null;
    }
}

// Function to fetch Telegram and Twitter links
async function getTelegramAndTwitterLinks(tokenMint, offChainMetadata) {
    const links = await fetchLinksFromDexScreener(tokenMint);
    const Telegram = links.telegramLink !== "N/A" ? links.telegramLink : extractTelegramLink(JSON.stringify(offChainMetadata));
    const Twitter = links.twitterLink !== "N/A" ? links.twitterLink : extractTwitterLink(JSON.stringify(offChainMetadata));

    return { Telegram, Twitter };
}

// Function to fetch both Telegram and Twitter links from DexScreener
async function fetchLinksFromDexScreener(tokenMint) {
    try {
        const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data) {
            console.error("No data received from DexScreener:", data);
            return { telegramLink: "N/A", twitterLink: "N/A" };
        }

        const telegramLink = extractTelegramLink(JSON.stringify(data)) || "N/A";
        const twitterLink = extractTwitterLink(JSON.stringify(data)) || "N/A";
        return { telegramLink, twitterLink };
    } catch (error) {
        console.error("Failed to fetch links from DexScreener:", error);
        return { telegramLink: "N/A", twitterLink: "N/A" };
    }
}


async function getTokenSupply(tokenMint) {
    try {
        const requestPayload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenSupply",
            params: [tokenMint]
        };

        const response = await axios.post(rpcUrl, requestPayload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;

        if (data.error) {
            console.error("Error fetching token supply:", data.error);
            return null;
        }

        const supply = data.result.value;
        return supply.amount / Math.pow(10, supply.decimals);
    } catch (error) {
        console.error("Error:", error);
        return null;
    }
}

async function getPrice(tokenMint) {
    const apiUrl = `https://api-v3.raydium.io/mint/price?mints=${tokenMint}`;

    try {
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (data && data.success && data.data && data.data[tokenMint]) {
            return data.data[tokenMint];
        } else {
            console.error("Error fetching token price: Invalid response structure", data);
            return null;
        }
    } catch (error) {
        console.error("Error:", error);
        return null;
    }
}

function isValidBase58Address(address) {
    const base58Regex = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
    return base58Regex.test(address);
}

async function formatMessage(fromAddress, tokenMint, amountReceived, marketCap, bagWorthUSD, bagWorthSolana, Ticker, tokenSymbol, Twitter, Telegram, signature, imageUrl) {
    let socialLink = (Telegram && !Telegram.startsWith("Fehler:") && Telegram !== "N/A")
    ? Telegram
    : `https://dexscreener.com/solana/${tokenMint}`;
    let shortAddress = fromAddress ? `${fromAddress.slice(0, 6)}...${fromAddress.slice(-4)}` : 'Unknown';
    let formattedMarketCap = marketCap !== null ? marketCap.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 }) : 'N/A';
    let position = getPosition(tokenMint);

    const formattedBagWorthUSD = bagWorthUSD ? bagWorthUSD.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'N/A';
    const formattedBagWorthSolana = bagWorthSolana ? bagWorthSolana.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'N/A';

    const messageText = 
`<a href="${socialLink}" style="color: blue; font-weight: bold;"><b>${Ticker}</b></a> <b>BUY!</b>

🔀 ${formattedBagWorthSolana} SOL (<b>$${formattedBagWorthUSD}</b>)
🔀 ${amountReceived.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} <b>${Ticker}</b>
👤<a href="https://solscan.io/account/${fromAddress}"> ${shortAddress}</a> | <a href="https://solscan.io/tx/${signature}">Txn</a>
💸 <b>Market Cap</b> $${formattedMarketCap}
📈 <a href="https://dexscreener.com/solana/${tokenMint}">Chart</a>   ⏫ <b>Trending #${position}</b>

🐴 <a href="https://t.me/solana_trojanbot?start=r-majolie814046">Buy on trojan</a>`;

    try {
        if (isValidUrl(imageUrl)) {
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data, 'binary');
            await bot.sendPhoto(chatId, buffer, { caption: messageText, parse_mode: 'HTML' });
        } else {
            console.error('Invalid or missing image URL, not sending message without image.');
        }
    } catch (error) {
        console.error('Failed to send the image or message:', error);
    }
}


function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

function getPosition(tokenMint) {
    let sortedTokenData = Object.values(tokenDataStore).sort((a, b) => b.BagWorth - a.BagWorth);
    let position = sortedTokenData.findIndex(data => data.tokenMint === tokenMint) + 1;
    return position || 5;
}

async function getTokenMetadata(tokenMint) {
    try {
        const connection = new Connection("https://api.mainnet-beta.solana.com");
        const metaplex = Metaplex.make(connection);

        const mintAddress = new PublicKey(`${tokenMint}`);

        let tokenName;
        let tokenSymbol;
        let tokenLogo;
        let tokenJSON;

        const metadataAccount = metaplex
            .nfts()
            .pdas()
            .metadata({ mint: mintAddress });

        const metadataAccountInfo = await connection.getAccountInfo(metadataAccount);

        if (metadataAccountInfo) {
            const token = await metaplex.nfts().findByMint({ mintAddress: mintAddress });
            tokenName = token.name;
            tokenSymbol = token.symbol;
            tokenLogo = token.json?.image;
            tokenJSON = token.json;
        } else {
            const provider = await new TokenListProvider().resolve();
            const tokenList = provider.filterByChainId(ENV.MainnetBeta).getList();

            const tokenMap = tokenList.reduce((map, item) => {
                map.set(item.address, item);
                return map;
            }, new Map());

            const token = tokenMap.get(mintAddress.toBase58());

            tokenName = token.name;
            tokenSymbol = token.symbol;
            tokenLogo = token.logoURI;
            tokenJSON = token.MetadataUri;
        }

        //console.log("Token Name:", tokenName);
        //console.log("Token Symbol:", tokenSymbol);
        //console.log("Token Logo URI:", tokenLogo);
        //console.log("Token URI:", tokenJSON);
        //console.log("Public-Key:", mintAddress);

        const telegramLink = extractTelegramLink(JSON.stringify(tokenJSON));
        return { tokenSymbol, telegramLink };
    } catch (error) {
        console.error("Failed to fetch token metadata:", error);
        return { tokenSymbol: "N/A", telegramLink: "N/A" };
    }
}

async function getTelegramLinkFromDexScreener(tokenMint) {
    try {
        const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data) {
            console.error("No data received from DexScreener:", data);
            return "N/A";
        }

        const telegramLink = extractTelegramLink(JSON.stringify(data)) || "N/A";
        return telegramLink;
    } catch (error) {
        console.error("Failed to fetch Telegram link from DexScreener:", error);
        return "N/A";
    }
}

async function getTwitterLinkFromDexScreener(tokenMint) {
    try {
        const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data) {
            console.error("No data received from DexScreener:", data);
            return "N/A";
        }

        const twitterLink = extractTwitterLink(JSON.stringify(data)) || "N/A";
        return twitterLink;
    } catch (error) {
        console.error("Failed to fetch Twitter link from DexScreener:", error);
        return "N/A";
    }
}

function extractTelegramLink(jsonString) {
    try {
        const jsonObj = JSON.parse(jsonString);

        // Recursive function to search for the Telegram link
        function searchForTelegram(obj) {
            for (const key in obj) {
                if (typeof obj[key] === 'object' && obj[key] !== null) {
                    const result = searchForTelegram(obj[key]);
                    if (result) return result;
                } else if (typeof obj[key] === 'string' && obj[key].includes('t.me/')) {
                    return obj[key];
                }
            }
            return null;
        }

        const telegramLink = searchForTelegram(jsonObj);
        if (telegramLink) {
            return telegramLink;
        } else {
            throw new Error('Kein Telegram-Link gefunden');
        }
    } catch (error) {
        return `Fehler: ${error.message}`;
    }
}

function extractTwitterLink(jsonString) {
    try {
        const jsonObj = JSON.parse(jsonString);

        // Recursive function to search for the Twitter link
        function searchForTwitter(obj) {
            for (const key in obj) {
                if (typeof obj[key] === 'object' && obj[key] !== null) {
                    const result = searchForTwitter(obj[key]);
                    if (result) return result;
                } else if (typeof obj[key] === 'string' && obj[key].includes('twitter.com/')) {
                    return obj[key];
                }
            }
            return null;
        }

        const twitterLink = searchForTwitter(jsonObj);
        if (twitterLink) {
            return twitterLink;
        } else {
            throw new Error('Kein Twitter-Link gefunden');
        }
    } catch (error) {
        return `Fehler: ${error.message}`;
    }
}

let lastTrendingMessageId = null;

// Funktion zum Sortieren der Token-Mints nach BagWorth
function sortTokensByBagWorth() {
    // Konvertiere tokenDataStore in ein Array von Werten
    const tokensArray = Object.values(tokenDataStore);

    // Sortiere das Array nach BagWorth absteigend
    tokensArray.sort((a, b) => b.BagWorth - a.BagWorth);

    // Extrahiere die Token-Mints in der sortierten Reihenfolge
    const sortedTokenMints = tokensArray.map(token => token.tokenMint);

    return sortedTokenMints;
}

// Funktion zum Erzeugen der Nachricht für das Leaderboard
async function generateTopTrendingMessage() {
    let sortedTokenMints = sortTokensByBagWorth(); // Sort tokens by BagWorth
    let message = '<b>Top Trojan Trending</b>\n\n';

    for (let index = 0; index < sortedTokenMints.length && index < 12; index++) {
        const tokenMint = sortedTokenMints[index];
        const data = tokenDataStore[tokenMint]; // Get token data based on sorted token mint

        // Ensure the required fields are present
        if (!data || !data.Name || !data.Ticker) {
            console.error(`Missing required data for tokenMint: ${tokenMint}`);
            continue;
        }

        const priceChange = await getPriceChange(tokenMint);
        if (!priceChange) {
            console.error(`Price Change could not be retrieved for ${tokenMint}.`);
            continue;
        }

        // Skip tokens with 0 price change
        if (priceChange === 0) {
            console.log(`Token with price change 0 skipped: ${tokenMint}`);
            continue;
        }

        let positionEmoji = '';
        switch (index) {
            case 0:
                positionEmoji = '🥇';
                break;
            case 1:
                positionEmoji = '🥈';
                break;
            case 2:
                positionEmoji = '🥉';
                break;
            default:
                positionEmoji = '';
        }

        // Print out the Telegram link for debugging
        console.log(`Token ${tokenMint}: Telegram link is "${data.Telegram}"`);

        // Use the Telegram link if it's valid; otherwise, use the DexScreener link
        let socialLink = (data.Telegram && !data.Telegram.startsWith("Fehler:") && data.Telegram !== "N/A")
            ? data.Telegram
            : `https://dexscreener.com/solana/${tokenMint}`;

        // Print out the determined socialLink for further debugging
        console.log(`Token ${tokenMint}: Using social link ${socialLink}`);

        // Construct the message for this token
        let formattedMessage = `${positionEmoji} ${index + 1}. <a href="${socialLink}">${data.Name} | ${data.Ticker}</a> | <a href="https://dexscreener.com/solana/${tokenMint}">${priceChange}%</a>\n`;

        if (index < 3) {
            formattedMessage += '\n\n\n';
        } else {
            formattedMessage += '';
        }

        message += formattedMessage;
    }

    return message;
}


// Funktion zum Senden und Aktualisieren des Leaderboards
async function sendAndEditLeaderboardMessage(chatId) {
    let messageId = null;

    // Initiale Nachricht senden
    try {
        const initialMessage = await generateTopTrendingMessage();
        const sentMessage = await bot.sendMessage(chatId, initialMessage, { parse_mode: 'HTML', disable_web_page_preview: true });
        messageId = sentMessage.message_id;
    } catch (error) {
        console.error('Error sending initial message:', error);
        return; // Abbrechen, wenn die initiale Nachricht nicht gesendet werden konnte
    }

    const interval = 10000; // Aktualisierung alle 10 Sekunden

    const editInterval = setInterval(async () => {
        try {
            const messageText = await generateTopTrendingMessage();

            await bot.editMessageText(messageText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (error) {
            console.error('Error editing message:', error);
        }
    }, interval);
}

// Starten der Leaderboard-Aktualisierung
sendAndEditLeaderboardMessage(chatId);

// Check transactions every 10 seconds
setInterval(checkTransactions, checkInterval);

//console.log(`Tracking wallet ${walletAddress} started...`);

bot.on('polling_error', console.log);
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Bot started. You will receive updates on new transactions.');
});


//console.log('Bot is running...');
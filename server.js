const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = 3000;
const EXCEL_DIR = path.join(__dirname, 'excel_files');

// Global processing state
let processingState = {
    isProcessing: false,
    currentKeywords: [],
    processedKeywords: [],
    currentKeywordIndex: 0,
    currentQuery: '',
    currentCount: 0,
    startTime: null,
    processId: null,
    completedFiles: []
};

// Ensure excel directory exists
if (!fs.existsSync(EXCEL_DIR)) {
    fs.mkdirSync(EXCEL_DIR, { recursive: true });
}
// GOOGLE MAPS LEFT PANEL DETECTOR (Known Selectors + Structure Detection + Retry)
async function detectLeftPanel(page) {
    // 1️⃣ Known selectors (fast path)
    const knownSelectors = [
        'div[role="feed"]',
        'div[role="region"]',
        'div.m6QErb.DxyBCb.kA9KIf.dS8AEf',
        'div.m6QErb.tLjsW.eKbjU',
        'div.section-scrollbox',
        'div.scrollable-pane',
        'div[jscontroller][jsaction][aria-label]',
        'div[aria-label][class*="scroll"]'
    ];

    for (const selector of knownSelectors) {
        const found = await page.$(selector);
        if (found) {
            console.log(`✅ Left panel detected (known selector): ${selector}`);
            return found;
        }
    }

    console.log("⚠️ Known selectors failed. Switching to structure-based detection...");

    // 2️⃣ Structure-based detection (permanent fallback)
    const allContainers = await page.$$('div, section');

    for (const el of allContainers) {
        try {
            const rect = await el.boundingBox();
            if (!rect) continue;

            // Must be tall enough but not fullscreen
            if (rect.height < 250 || rect.height > 1200) continue;

            // Check scrollability
            const isScrollable = await page.evaluate(element => {
                const style = window.getComputedStyle(element);
                return (
                    style.overflowY === 'scroll' ||
                    style.overflowY === 'auto' ||
                    element.scrollHeight > element.clientHeight + 40
                );
            }, el);

            if (!isScrollable) continue;

            // Must contain business list items
            const hasBusinessListings = await page.evaluate(element => {
                return element.querySelector('a[href*="maps/place"]') ||
                       element.querySelector('a[href*="/maps/search"]') ||
                       element.querySelector('a[data-js-log-root]') ||
                       element.querySelector('a[jsaction]');
            }, el);

            if (!hasBusinessListings) continue;

            console.log("✅ Left panel detected (structure-based).");
            return el;

        } catch (err) {
            continue;
        }
    }

    console.log("❌ Left panel NOT detected. Retrying in 3 seconds...");

    // 3️⃣ Retry logic (Google Maps sometimes loads slow)
    await page.waitForTimeout(3000);

    for (const selector of knownSelectors) {
        const found = await page.$(selector);
        if (found) {
            console.log(`🔁 Retried and detected left panel using: ${selector}`);
            return found;
        }
    }

    console.log("😓 Panel detection failed even after retry.");
    return null;
}



// 🟢 Enhanced contact extraction with internal pages
async function extractContactInfoFromWebsite(url, visitInternalPages = true) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        console.log(`🌐 Visiting website: ${url}`);

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Extract from homepage
        let contactInfo = await extractFromPage(page, url);

        // If no contacts found and visitInternalPages is true, try internal pages
        if (visitInternalPages && (contactInfo.emails.length === 0 || contactInfo.facebook.length === 0 || contactInfo.instagram.length === 0)) {
            console.log('🔍 Searching internal pages for more contact info...');

            const internalPages = await findInternalPages(page, url);
            for (const internalUrl of internalPages.slice(0, 3)) { // Limit to 3 internal pages
                try {
                    console.log(`🌐 Checking internal page: ${internalUrl}`);
                    const internalInfo = await extractFromPage(page, internalUrl);

                    // Merge results
                    contactInfo.emails = [...new Set([...contactInfo.emails, ...internalInfo.emails])];
                    contactInfo.facebook = [...new Set([...contactInfo.facebook, ...internalInfo.facebook])];
                    contactInfo.instagram = [...new Set([...contactInfo.instagram, ...internalInfo.instagram])];
                } catch (err) {
                    console.log(`⚠️ Error checking internal page ${internalUrl}: ${err.message}`);
                }
            }
        }

        return contactInfo;
    } catch (err) {
        console.error(`⚠️ Failed to extract website info: ${err.message}`);
        return { emails: [], facebook: [], instagram: [] };
    } finally {
        await browser.close();
    }
}

// Find internal pages (contact, about, etc.)
async function findInternalPages(page, baseUrl) {
    try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const internalPages = await page.evaluate((base) => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            const baseHost = new URL(base).hostname;
            const keywords = ['contact', 'about', 'team', 'staff', 'reach', 'get-in-touch'];

            return links
                .map(link => link.href)
                .filter(href => {
                    try {
                        const url = new URL(href);
                        return url.hostname === baseHost &&
                               keywords.some(keyword => href.toLowerCase().includes(keyword));
                    } catch { return false; }
                })
                .slice(0, 5); // Limit results
        }, baseUrl);

        return [...new Set(internalPages)];
    } catch (err) {
        console.log(`⚠️ Error finding internal pages: ${err.message}`);
        return [];
    }
}

// Extract contact info from a specific page
async function extractFromPage(page, url) {
    try {
        console.log(`🔍 Extracting contacts from: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for dynamic content to load
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Try to scroll to trigger lazy loading
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });

        // Wait a bit more after scrolling
        await new Promise(resolve => setTimeout(resolve, 3000));

        const html = await page.content();
        console.log(`📄 Page content length: ${html.length} characters`);

        // 📧 Extract emails with enhanced patterns
        let emails = [...new Set(
            (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi) || [])
                .filter(email => {
                    const lower = email.toLowerCase();
                    return !lower.endsWith('.png') &&
                           !lower.endsWith('.jpg') &&
                           !lower.endsWith('.jpeg') &&
                           !lower.includes('example') &&
                           !lower.includes('test@') &&
                           !lower.includes('noreply') &&
                           !lower.includes('no-reply') &&
                           lower.includes('.');
                })
        )];

        // Also look for obfuscated emails like "contact[at]domain[dot]com"
        const obfuscatedEmails = (html.match(/[a-zA-Z0-9._%+-]+\s*\[\s*at\s*\]\s*[a-zA-Z0-9.-]+\s*\[\s*dot\s*\]\s*[a-zA-Z]{2,}/gi) || [])
            .map(email => email.replace(/\s*\[\s*at\s*\]\s*/gi, '@').replace(/\s*\[\s*dot\s*\]\s*/gi, '.'));

        emails = [...new Set([...emails, ...obfuscatedEmails])];

        console.log(`📧 Found ${emails.length} emails: ${emails.join(', ')}`);

        // 🌐 Extract Facebook links with better patterns and filtering
        let facebook = [...new Set(
            (html.match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/[a-zA-Z0-9._%+-]+/gi) || [])
                .map(link => link.startsWith('http') ? link : 'https://' + link)
                .filter(link =>
                    !link.includes('/login') &&
                    !link.includes('/share') &&
                    !link.includes('/tr') &&
                    !link.includes('/people') &&
                    !link.includes('/plugins') &&
                    !link.includes('/sharer') &&
                    !link.includes('/dialog') &&
                    !link.includes('/connect') &&
                    !link.includes('/privacy') &&
                    !link.includes('/help') &&
                    link.length > 25 // Filter out very short/generic links
                )
        )];

        console.log(`📘 Found ${facebook.length} Facebook links: ${facebook.join(', ')}`);

        // 📸 Extract Instagram links with better patterns and filtering
        let instagramLinks = [...new Set(
            (html.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9._]+/gi) || [])
                .map(link => link.startsWith('http') ? link : 'https://' + link)
                .filter(link =>
                    !link.includes('/p/') &&
                    !link.includes('/reel/') &&
                    !link.includes('/tv/') &&
                    !link.includes('/stories/') &&
                    !link.includes('/explore/') &&
                    !link.includes('/accounts/') &&
                    !link.includes('/direct/') &&
                    link.length > 25 // Filter out short/generic links
                )
        )];

        const profiles = instagramLinks.filter(link =>
            !link.includes('/p/') &&
            !link.includes('/reel/') &&
            !link.includes('/tv/') &&
            !link.includes('/stories/')
        );

        let instagram = profiles;
        if (profiles.length === 0 && instagramLinks.length > 0) {
            instagram = [instagramLinks[0]];
        }

        console.log(`📸 Found ${instagram.length} Instagram links: ${instagram.join(', ')}`);

        return { emails, facebook, instagram };
    } catch (err) {
        console.error(`⚠️ Error extracting from ${url}: ${err.message}`);
        return { emails: [], facebook: [], instagram: [] };
    }
}

// 🟢 Scrape Google Maps businesses with enhanced contact extraction
async function scrapeGoogleMaps(searchQuery, targetCount, visitInternalPages = true) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        console.log(`🌐 Navigating to Google Maps for: ${searchQuery}`);

        await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`, {
            waitUntil: 'networkidle2',
            timeout: 90000
        });

        console.log('📜 Scrolling left panel to load businesses...');
        const MAX_SCROLLS = 20;
        let lastCount = 0;
        let noNewResultsCount = 0;

        for (let i = 0; i < MAX_SCROLLS; i++) {const panel = await detectLeftPanel(page);
if (!panel) {
    console.log("❌ Could not detect left panel. Stopping scroll.");
    break;
}


            await page.evaluate(el => el.scrollBy(0, el.scrollHeight), panel);
            console.log(`🔽 Scrolled panel: ${i + 1}`);

            const delay = targetCount < 20 ? 3000 : 15000;
            await new Promise(resolve => setTimeout(resolve, delay));

            const currentCount = await page.evaluate(() =>
                document.querySelectorAll('a.hfpxzc').length
            );
            console.log(`📦 Businesses loaded: ${currentCount}`);

            if (currentCount >= targetCount) {
                console.log(`✅ Target of ${targetCount} businesses reached.`);
                break;
            }

            if (currentCount === lastCount) {
                noNewResultsCount++;
                if (noNewResultsCount >= 2) {
                    console.log('⚠️ No more new results. Stopping scroll.');
                    break;
                }
                console.log('⏳ No new results. Waiting 30s...');
                await new Promise(resolve => setTimeout(resolve, 30000));
            } else {
                noNewResultsCount = 0;
            }

            lastCount = currentCount;
        }

        const businesses = await page.evaluate(() => {
            const anchors = [...document.querySelectorAll('a.hfpxzc')];
            return anchors.map(a => ({
                name: a.getAttribute('aria-label') || '',
                link: a.href
            }));
        });

        console.log(`📦 Total businesses found: ${businesses.length}`);

        const results = [];
        for (let i = 0; i < Math.min(businesses.length, targetCount); i++) {
            const business = businesses[i];
            console.log(`🔍 Processing ${i + 1}/${targetCount}: ${business.name}`);

            try {
                const mapPage = await browser.newPage();
                await mapPage.setRequestInterception(true);
                mapPage.on('request', (req) => {
                    if (['image', 'font'].includes(req.resourceType())) req.abort();
                    else req.continue();
                });

                await mapPage.goto(business.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await new Promise(resolve => setTimeout(resolve, 3000));

                const phone = await mapPage.evaluate(() => {
                    const span = Array.from(document.querySelectorAll('button, span'))
                        .find(el => /\+?\d[\d\s\-().]{7,}/.test(el.textContent));
                    return span ? span.textContent.replace(/[^\d+()\-\s]/g, '').trim() : '';
                });

                const website = await mapPage.evaluate(() => {
                    const link = document.querySelector('a[data-item-id="authority"]');
                    return link ? link.href : '';
                });

                const { rating, reviews } = await mapPage.evaluate(() => {
                    const ratingEl = Array.from(document.querySelectorAll('span')).find(el =>
                        el.getAttribute('aria-hidden') === 'true' && /^\d+(\.\d+)?$/.test(el.textContent.trim())
                    );
                    const reviewsEl = Array.from(document.querySelectorAll('span')).find(el =>
                        /\(\d{1,3}(,\d{3})*\)/.test(el.textContent.trim())
                    );
                    return {
                        rating: ratingEl ? ratingEl.textContent.trim() : '',
                        reviews: reviewsEl ? reviewsEl.textContent.replace(/[()]/g, '').trim() : ''
                    };
                });

                // Extract contact info from website if available
                let contactInfo = { emails: [], facebook: [], instagram: [] };
                if (website) {
                    try {
                        console.log(`🌐 Processing website: ${website} for ${business.name}`);
                        contactInfo = await extractContactInfoFromWebsite(website, visitInternalPages);
                        console.log(`✅ Contact extraction complete for ${business.name}:`, contactInfo);
                    } catch (err) {
                        console.log(`⚠️ Error extracting contact info from ${website}: ${err.message}`);
                    }
                } else {
                    console.log(`❌ No website found for ${business.name}`);
                }

                results.push({
                    name: business.name,
                    maps_link: business.link,
                    phone,
                    website,
                    rating,
                    reviews,
                    emails: contactInfo.emails.join(', '),
                    facebook: contactInfo.facebook.join(', '),
                    instagram: contactInfo.instagram.join(', ')
                });

                await mapPage.close();
            } catch (err) {
                console.log(`⚠️ Error processing ${business.name}: ${err.message}`);
                results.push({
                    name: business.name,
                    maps_link: business.link,
                    phone: '',
                    website: '',
                    rating: '',
                    reviews: '',
                    emails: '',
                    facebook: '',
                    instagram: ''
                });
            }
        }

        console.log(`✅ Done scraping ${results.length} businesses`);
        return results;
    } finally {
        await browser.close();
    }
}

// Create Excel file
async function createExcelFile(data, filename) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Lead Data');

    // Define columns
    worksheet.columns = [
        { header: 'Business Name', key: 'name', width: 30 },
        { header: 'Phone', key: 'phone', width: 20 },
        { header: 'Website', key: 'website', width: 40 },
        { header: 'Rating', key: 'rating', width: 10 },
        { header: 'Reviews', key: 'reviews', width: 15 },
        { header: 'Emails', key: 'emails', width: 40 },
        { header: 'Facebook', key: 'facebook', width: 40 },
        { header: 'Instagram', key: 'instagram', width: 40 },
        { header: 'Maps Link', key: 'maps_link', width: 50 }
    ];

    // Style header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE6E6FA' }
    };

    // Add data
    data.forEach(row => {
        worksheet.addRow(row);
    });

    // Save file
    const filepath = path.join(EXCEL_DIR, filename);
    await workbook.xlsx.writeFile(filepath);
    return filepath;
}

// 🌟 API Endpoints

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get current processing status
app.get('/api/status', (req, res) => {
    res.json({
        isProcessing: processingState.isProcessing,
        currentKeywords: processingState.currentKeywords,
        processedKeywords: processingState.processedKeywords,
        currentKeywordIndex: processingState.currentKeywordIndex,
        currentQuery: processingState.currentQuery,
        currentCount: processingState.currentCount,
        startTime: processingState.startTime,
        processId: processingState.processId,
        completedFiles: processingState.completedFiles,
        elapsed: processingState.startTime ? Date.now() - processingState.startTime : 0,
        progress: processingState.currentKeywords.length > 0 ?
            ((processingState.processedKeywords.length / processingState.currentKeywords.length) * 100).toFixed(1) : 0
    });
});

// Scrape and generate Excel for multiple keywords
app.post('/api/scrape', async (req, res) => {
    const { keywords, count, visitInternalPages = true } = req.body;

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0 || !count) {
        return res.status(400).json({ error: 'Missing keywords array or count parameter' });
    }

    // Check if already processing
    if (processingState.isProcessing) {
        return res.status(429).json({
            error: 'Another scraping process is already running',
            currentProcess: {
                keywords: processingState.currentKeywords,
                processedKeywords: processingState.processedKeywords,
                currentQuery: processingState.currentQuery,
                elapsed: Date.now() - processingState.startTime,
                progress: processingState.currentKeywords.length > 0 ?
                    ((processingState.processedKeywords.length / processingState.currentKeywords.length) * 100).toFixed(1) : 0
            }
        });
    }

    // Set processing state for multiple keywords
    processingState.isProcessing = true;
    processingState.currentKeywords = [...keywords];
    processingState.processedKeywords = [];
    processingState.currentKeywordIndex = 0;
    processingState.currentQuery = keywords[0];
    processingState.currentCount = parseInt(count);
    processingState.startTime = Date.now();
    processingState.processId = `proc_${Date.now()}`;
    processingState.completedFiles = [];

    try {
        console.log(`🚀 Starting multi-keyword scrape: ${keywords.join(', ')} (${count} results each) - Process ID: ${processingState.processId}`);

        // Return immediately with process info
        res.json({
            success: true,
            message: 'Multi-keyword scraping process started',
            processId: processingState.processId,
            keywords: processingState.currentKeywords,
            count: processingState.currentCount
        });

        // Process each keyword sequentially
        for (let i = 0; i < keywords.length; i++) {
            const keyword = keywords[i];

            // Update current processing state
            processingState.currentKeywordIndex = i;
            processingState.currentQuery = keyword;

            console.log(`🎯 Processing keyword ${i + 1}/${keywords.length}: "${keyword}"`);

            try {
                // Scrape current keyword
                const results = await scrapeGoogleMaps(keyword, parseInt(count), visitInternalPages);

                // Generate filename for this keyword
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
                const filename = `leads_${keyword.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}_${Date.now()}.xlsx`;

                // Create Excel file
                await createExcelFile(results, filename);

                // Add to completed files
                processingState.completedFiles.push({
                    keyword: keyword,
                    filename: filename,
                    resultCount: results.length,
                    timestamp: new Date().toISOString()
                });

                // Mark keyword as processed
                processingState.processedKeywords.push(keyword);

                console.log(`✅ Completed keyword "${keyword}": ${results.length} results saved to ${filename}`);

            } catch (err) {
                console.error(`❌ Error processing keyword "${keyword}": ${err.message}`);

                // Mark as processed even if failed, to continue with next
                processingState.processedKeywords.push(keyword);
                processingState.completedFiles.push({
                    keyword: keyword,
                    filename: null,
                    resultCount: 0,
                    error: err.message,
                    timestamp: new Date().toISOString()
                });
            }
        }

        console.log(`🎉 All keywords completed! Processed: ${processingState.processedKeywords.join(', ')}`);

        // Clear processing state
        processingState.isProcessing = false;
        processingState.currentKeywords = [];
        processingState.processedKeywords = [];
        processingState.currentKeywordIndex = 0;
        processingState.currentQuery = '';
        processingState.currentCount = 0;
        processingState.startTime = null;
        processingState.processId = null;

    } catch (err) {
        console.error(`❌ Multi-keyword Scraping Error: ${err.message}`);

        // Clear processing state on error
        processingState.isProcessing = false;
        processingState.currentKeywords = [];
        processingState.processedKeywords = [];
        processingState.currentKeywordIndex = 0;
        processingState.currentQuery = '';
        processingState.currentCount = 0;
        processingState.startTime = null;
        processingState.processId = null;
    }
});

// Get scraping results and live updates
app.get('/api/results/:processId', (req, res) => {
    const { processId } = req.params;

    // If still processing and matches current process
    if (processingState.isProcessing && processingState.processId === processId) {
        return res.json({
            status: 'processing',
            keywords: processingState.currentKeywords,
            processedKeywords: processingState.processedKeywords,
            currentKeywordIndex: processingState.currentKeywordIndex,
            currentQuery: processingState.currentQuery,
            count: processingState.currentCount,
            elapsed: Date.now() - processingState.startTime,
            completedFiles: processingState.completedFiles,
            progress: processingState.currentKeywords.length > 0 ?
                ((processingState.processedKeywords.length / processingState.currentKeywords.length) * 100).toFixed(1) : 0
        });
    }

    // If not processing, return completion status with all files
    return res.json({
        status: 'completed',
        completedFiles: processingState.completedFiles || [],
        message: processingState.completedFiles?.length > 0 ?
            `All keywords completed! Generated ${processingState.completedFiles.length} files.` :
            'Process completed'
    });
});

// Get list of Excel files
app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(EXCEL_DIR)
            .filter(file => file.endsWith('.xlsx'))
            .map(file => {
                const filepath = path.join(EXCEL_DIR, file);
                const stats = fs.statSync(filepath);
                return {
                    name: file,
                    size: (stats.size / 1024).toFixed(2) + ' KB',
                    created: stats.birthtime.toISOString()
                };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));

        res.json(files);
    } catch (err) {
        console.error(`❌ Error reading files: ${err.message}`);
        res.status(500).json({ error: 'Error reading files' });
    }
});

// Download Excel file
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(EXCEL_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filepath, filename);
});

// Delete Excel file
app.delete('/api/files/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(EXCEL_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        fs.unlinkSync(filepath);
        res.json({ success: true, message: 'File deleted successfully' });
    } catch (err) {
        console.error(`❌ Error deleting file: ${err.message}`);
        res.status(500).json({ error: 'Error deleting file' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 LeadPilot System live at http://0.0.0.0:${PORT}`);
    console.log(`📁 Excel files stored in: ${EXCEL_DIR}`);
});

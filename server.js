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
    currentQuery: '',
    currentCount: 0,
    startTime: null,
    processId: null
};

// Ensure excel directory exists
if (!fs.existsSync(EXCEL_DIR)) {
    fs.mkdirSync(EXCEL_DIR, { recursive: true });
}

// 🟢 Enhanced contact extraction with internal pages
async function extractContactInfoFromWebsite(url, visitInternalPages = true) {
    const browser = await puppeteer.launch({
        headless: true,
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
                           lower.includes('.');
                })
        )];

        // Also look for obfuscated emails like "contact[at]domain[dot]com"
        const obfuscatedEmails = (html.match(/[a-zA-Z0-9._%+-]+\s*\[\s*at\s*\]\s*[a-zA-Z0-9.-]+\s*\[\s*dot\s*\]\s*[a-zA-Z]{2,}/gi) || [])
            .map(email => email.replace(/\s*\[\s*at\s*\]\s*/gi, '@').replace(/\s*\[\s*dot\s*\]\s*/gi, '.'));
        
        emails = [...new Set([...emails, ...obfuscatedEmails])];

        console.log(`📧 Found ${emails.length} emails: ${emails.join(', ')}`);

        // 🌐 Extract Facebook links with better patterns
        let facebook = [...new Set(
            (html.match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/[a-zA-Z0-9._%+-]+/gi) || [])
                .map(link => link.startsWith('http') ? link : 'https://' + link)
                .filter(link => !link.includes('/login') && !link.includes('/share'))
        )];

        console.log(`📘 Found ${facebook.length} Facebook links: ${facebook.join(', ')}`);

        // 📸 Extract Instagram links with better patterns
        let instagramLinks = [...new Set(
            (html.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9._]+/gi) || [])
                .map(link => link.startsWith('http') ? link : 'https://' + link)
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
        headless: true,
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

        for (let i = 0; i < MAX_SCROLLS; i++) {
            const panel = await page.$('div[role="feed"]');
            if (!panel) {
                console.log('❌ Left panel not found!');
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
        currentQuery: processingState.currentQuery,
        currentCount: processingState.currentCount,
        startTime: processingState.startTime,
        processId: processingState.processId,
        elapsed: processingState.startTime ? Date.now() - processingState.startTime : 0
    });
});

// Scrape and generate Excel
app.post('/api/scrape', async (req, res) => {
    const { query, count, visitInternalPages = true } = req.body;

    if (!query || !count) {
        return res.status(400).json({ error: 'Missing query or count parameter' });
    }

    // Check if already processing
    if (processingState.isProcessing) {
        return res.status(429).json({ 
            error: 'Another scraping process is already running',
            currentProcess: {
                query: processingState.currentQuery,
                count: processingState.currentCount,
                elapsed: Date.now() - processingState.startTime
            }
        });
    }

    // Set processing state
    processingState.isProcessing = true;
    processingState.currentQuery = query;
    processingState.currentCount = parseInt(count);
    processingState.startTime = Date.now();
    processingState.processId = `proc_${Date.now()}`;

    try {
        console.log(`🚀 Starting scrape: ${query} (${count} results) - Process ID: ${processingState.processId}`);
        
        // Start scraping in background but return immediately with process ID
        const scrapePromise = scrapeGoogleMaps(query, parseInt(count), visitInternalPages);
        
        res.json({
            success: true,
            message: 'Scraping process started',
            processId: processingState.processId,
            query: processingState.currentQuery,
            count: processingState.currentCount
        });

        // Continue processing in background
        const results = await scrapePromise;
        
        // Generate filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `leads_${query.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}_${Date.now()}.xlsx`;
        
        // Create Excel file
        await createExcelFile(results, filename);
        
        console.log(`✅ Scraping completed: ${results.length} results saved to ${filename}`);
        
        // Clear processing state
        processingState.isProcessing = false;
        processingState.currentQuery = '';
        processingState.currentCount = 0;
        processingState.startTime = null;
        processingState.processId = null;

    } catch (err) {
        console.error(`❌ Scraping Error: ${err.message}`);
        
        // Clear processing state on error
        processingState.isProcessing = false;
        processingState.currentQuery = '';
        processingState.currentCount = 0;
        processingState.startTime = null;
        processingState.processId = null;
    }
});

// Get scraping results (check if completed)
app.get('/api/results/:processId', (req, res) => {
    const { processId } = req.params;
    
    // If still processing and matches current process
    if (processingState.isProcessing && processingState.processId === processId) {
        return res.json({
            status: 'processing',
            query: processingState.currentQuery,
            count: processingState.currentCount,
            elapsed: Date.now() - processingState.startTime
        });
    }

    // If not processing, check for recent files
    try {
        const files = fs.readdirSync(EXCEL_DIR)
            .filter(file => file.endsWith('.xlsx'))
            .map(file => {
                const filepath = path.join(EXCEL_DIR, file);
                const stats = fs.statSync(filepath);
                return {
                    name: file,
                    created: stats.birthtime.getTime(),
                    stats
                };
            })
            .sort((a, b) => b.created - a.created);

        // Return most recent file (likely the one just completed)
        if (files.length > 0) {
            const recentFile = files[0];
            return res.json({
                status: 'completed',
                filename: recentFile.name,
                size: (recentFile.stats.size / 1024).toFixed(2) + ' KB',
                created: new Date(recentFile.created).toISOString()
            });
        } else {
            return res.json({
                status: 'completed',
                message: 'No files found'
            });
        }
    } catch (err) {
        return res.json({
            status: 'error',
            error: 'Failed to check results'
        });
    }
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

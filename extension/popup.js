const FIRECRAWL_BASE = 'http://localhost:8010';
const BACKEND_BASE = 'http://localhost:5000';
const SCRAPE_ENDPOINT = `${BACKEND_BASE}/scrape-website`;

const scrapeBtn = document.getElementById('scrapeBtn');
const crawlBtn = document.getElementById('crawlBtn');
const saveBtn = document.getElementById('saveBtn');
const openDashboardBtn = document.getElementById('openDashboard');
const editor = document.getElementById('editor');
const urlInput = document.getElementById('url');
const spinner = document.getElementById('spinner');
const statusText = document.getElementById('statusText');
const crawlOptions = document.getElementById('crawlOptions');
const crawlStatus = document.getElementById('crawlStatus');
const crawlStatusText = document.getElementById('crawlStatusText');
const progressFill = document.getElementById('progressFill');

let currentCrawlId = null;
let crawlPollInterval = null;
let lastSavedId = null;

// Toggle crawl options visibility
crawlBtn.addEventListener('click', () => {
  const isVisible = crawlOptions.style.display !== 'none';
  crawlOptions.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    // If showing options, don't start crawl yet
    return;
  }
});

// Scrape functionality
scrapeBtn.onclick = async () => {
  const url = urlInput.value.trim();
  if (!url) {
    alert('Please enter a URL');
    return;
  }

  scrapeBtn.disabled = true;
  crawlBtn.disabled = true;
  spinner.classList.add('active');
  statusText.textContent = 'Scraping page...';
  editor.innerHTML = '';

  try {
    const res = await fetch(SCRAPE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || 'Scrape failed');
    }

    let data = {};
    try { data = JSON.parse(text); } catch {}
    const markdown = data.markdown || data?.data?.markdown || '';
    lastSavedId = data.id || null;

    if (markdown) {
      editor.innerText = markdown;
      statusText.textContent = lastSavedId ? `Saved ✓ (id=${lastSavedId})` : 'Scrape completed!';
      if (lastSavedId) { saveBtn.disabled = true; saveBtn.textContent = 'Saved'; }
    } else {
      statusText.textContent = 'Scrape completed (no markdown)';
    }
  } catch (error) {
    statusText.textContent = 'Scrape failed';
    editor.innerText = `Error: ${error.message}`;
    console.error('Scrape error:', error);
  } finally {
    scrapeBtn.disabled = false;
    crawlBtn.disabled = false;
    setTimeout(() => {
      spinner.classList.remove('active');
    }, 1000);
  }
};

// Crawl functionality
async function startCrawl() {
  const url = urlInput.value.trim();
  if (!url) {
    alert('Please enter a URL');
    return;
  }

  const maxDepth = parseInt(document.getElementById('maxDepth').value) || 2;
  const limit = parseInt(document.getElementById('limit').value) || 10;
  const includeMarkdown = document.getElementById('includeMarkdown').checked;

  scrapeBtn.disabled = true;
  crawlBtn.disabled = true;
  spinner.classList.add('active');
  statusText.textContent = 'Starting crawl...';
  crawlStatus.classList.add('active');
  crawlStatusText.textContent = 'Initializing crawl...';
  progressFill.style.width = '0%';
  editor.innerHTML = '';

  try {
    const res = await fetch(`${FIRECRAWL_BASE}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        maxDepth,
        limit,
        scrapeOptions: {
          formats: includeMarkdown ? ['markdown'] : ['html']
        }
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(errorText || 'Crawl failed to start');
    }

    const data = await res.json();
    currentCrawlId = data.id;

    statusText.textContent = 'Crawl in progress...';
    crawlStatusText.textContent = `Crawl ID: ${currentCrawlId}`;

    // Start polling for status
    pollCrawlStatus();
  } catch (error) {
    statusText.textContent = 'Crawl failed';
    crawlStatusText.textContent = `Error: ${error.message}`;
    console.error('Crawl error:', error);
    scrapeBtn.disabled = false;
    crawlBtn.disabled = false;
    spinner.classList.remove('active');
  }
}

// Poll crawl status
async function pollCrawlStatus() {
  if (crawlPollInterval) {
    clearInterval(crawlPollInterval);
  }

  crawlPollInterval = setInterval(async () => {
    if (!currentCrawlId) return;

    try {
      const res = await fetch(`${FIRECRAWL_BASE}/crawl/${currentCrawlId}`);
      if (!res.ok) {
        throw new Error('Failed to get crawl status');
      }

      const data = await res.json();
      const status = data.status;
      const total = data.total || 0;
      const completed = data.completed || 0;
      const progress = total > 0 ? (completed / total) * 100 : 0;

      progressFill.style.width = `${progress}%`;
      crawlStatusText.textContent = `Status: ${status} | ${completed}/${total} pages`;

      if (status === 'completed') {
        clearInterval(crawlPollInterval);
        crawlPollInterval = null;
        
        statusText.textContent = 'Crawl completed!';
        crawlStatusText.textContent = `Completed: ${completed} pages crawled`;
        progressFill.style.width = '100%';

        // Display results
        if (data.data && data.data.length > 0) {
          let content = '';
          data.data.forEach((page, index) => {
            content += `\n\n--- Page ${index + 1}: ${page.url} ---\n\n`;
            content += page.markdown || page.html || 'No content';
          });
          editor.innerText = content;
        }

        scrapeBtn.disabled = false;
        crawlBtn.disabled = false;
        spinner.classList.remove('active');
        currentCrawlId = null;
      } else if (status === 'failed') {
        clearInterval(crawlPollInterval);
        crawlPollInterval = null;
        
        statusText.textContent = 'Crawl failed';
        crawlStatusText.textContent = 'Crawl failed to complete';
        
        scrapeBtn.disabled = false;
        crawlBtn.disabled = false;
        spinner.classList.remove('active');
        currentCrawlId = null;
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, 2000); // Poll every 2 seconds
}

// Modified crawl button to actually start crawl when options are visible
crawlBtn.addEventListener('click', () => {
  const isVisible = crawlOptions.style.display !== 'none';
  if (isVisible) {
    // Options already visible, start the crawl
    startCrawl();
  } else {
    // Show options
    crawlOptions.style.display = 'block';
  }
});

// Save to notes
saveBtn.onclick = async () => {
  if (lastSavedId) {
    // Already saved by backend via scrape
    alert('This content was already saved during scraping. You can edit the text and save again to create a new note.');
    return;
  }
  const text = editor.innerText.trim();
  if (!text) {
    alert('Nothing to save');
    return;
  }

  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';

  try {
    await fetch(`${BACKEND_BASE}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        text,
        source_url: urlInput.value,
        metadata: {
          saved_at: new Date().toISOString()
        }
      })
    });
    
    saveBtn.textContent = '✓ Saved!';
    setTimeout(() => {
      saveBtn.textContent = originalText;
    }, 2000);
  } catch (error) {
    alert('Failed to save: ' + error.message);
    saveBtn.textContent = originalText;
  } finally {
    saveBtn.disabled = false;
  }
};

// Cleanup on popup close
window.addEventListener('unload', () => {
  if (crawlPollInterval) {
    clearInterval(crawlPollInterval);
  }
});

// Open dashboard page
if (openDashboardBtn) {
  openDashboardBtn.addEventListener('click', () => {
    const url = chrome.runtime.getURL('dashboard.html');
    // Avoid requiring tabs permission; window.open suffices
    window.open(url, '_blank');
  });
}

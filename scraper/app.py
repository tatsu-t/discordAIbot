from fastapi import FastAPI
from pydantic import BaseModel
from scrapling.fetchers import AsyncFetcher, StealthyFetcher
from typing import Optional
from urllib.parse import urlparse
import asyncio
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

MAX_TEXT_LENGTH = 300000
MAX_SCRIPTS_LENGTH = 100000
MAX_IMAGES = 20
MAX_LINKS = 50
MAX_CONCURRENT = 5


class ScrapeRequest(BaseModel):
    url: str


class MultiScrapeRequest(BaseModel):
    urls: list[str]


class ScrapeResult(BaseModel):
    url: str
    title: Optional[str] = None
    text: str = ""
    scripts: str = ""
    images: list[str] = []
    links: list[str] = []
    error: Optional[str] = None


def resolve_links(base_url: str, hrefs: list[str]) -> list[str]:
    parsed_base = urlparse(base_url)
    seen: set[str] = set()
    result: list[str] = []

    for href in hrefs:
        try:
            if href.startswith("http://") or href.startswith("https://"):
                resolved = href
            elif href.startswith("//"):
                # Protocol-relative URL (e.g. //example.com/path)
                resolved = f"{parsed_base.scheme}:{href}"
            elif href.startswith("/"):
                resolved = f"{parsed_base.scheme}://{parsed_base.netloc}{href}"
            else:
                continue

            if resolved not in seen:
                seen.add(resolved)
                result.append(resolved)
                if len(result) >= MAX_LINKS:
                    break
        except Exception:
            pass

    return result


STEALTH_DOMAINS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}

THIN_CONTENT_THRESHOLD = 200  # chars — likely a bot-block page

async def _fetch_page(url: str):
    """Try AsyncFetcher first; fall back to StealthyFetcher on thin/failed response."""
    domain = urlparse(url).netloc.lower()
    if domain in STEALTH_DOMAINS:
        return await StealthyFetcher.async_fetch(
            url, headless=True, network_idle=True, disable_resources=False
        )

    page = await AsyncFetcher.get(url, impersonate="chrome")

    # Detect bot-block: very little text means likely a challenge/error page
    sample = " ".join((page.xpath("//body//text()").getall() or [])[:50])
    if len(sample.strip()) < THIN_CONTENT_THRESHOLD:
        logger.info(f"Thin content for {url} — retrying with StealthyFetcher")
        page = await StealthyFetcher.async_fetch(
            url, headless=True, network_idle=True, disable_resources=False
        )

    return page


async def _scrape(url: str) -> ScrapeResult:
    try:
        page = await _fetch_page(url)

        title = page.css("title::text").get()

        # Try to extract from semantic content containers first,
        # falling back to full body with noise excluded
        NOISE_EXCLUDE = (
            "not(ancestor::script) and not(ancestor::style) and "
            "not(ancestor::noscript) and not(ancestor::nav) and "
            "not(ancestor::footer) and not(ancestor::header) and "
            "not(ancestor::aside)"
        )
        # Priority: paragraph-only (p/h* tags) from content containers,
        # then all-text fallback. Paragraph extraction avoids nav templates.
        CONTAINERS = [
            "//*[@id='mw-content-text']",
            "//*[contains(@class,'mw-parser-output')]",
            "//main",
            "//article",
            "//*[@role='main']",
            "//*[@id='main-content']",
            "//*[@id='content']",
            "//*[contains(@class,'article')]",
            "//body",
        ]
        PARA_TAGS = "self::p or self::h1 or self::h2 or self::h3 or self::h4 or self::li"
        text_nodes: list[str] = []
        chosen_container = "//body"

        for container in CONTAINERS:
            xpath_para = (
                f"{container}//*[{PARA_TAGS}]//text()["
                f"not(ancestor::script) and not(ancestor::style) and "
                f"not(ancestor::nav) and not(ancestor::footer) and "
                f"not(ancestor::*[contains(@class,'navbox')]) and "
                f"not(ancestor::*[contains(@class,'sidebar')]) and "
                f"not(ancestor::*[contains(@class,'infobox')]) and "
                f"not(ancestor::*[@id='toc'])"
                f"]"
            )
            nodes = page.xpath(xpath_para).getall()
            cleaned = [t.strip() for t in nodes if t.strip()]
            if len(cleaned) > 20:
                text_nodes = cleaned
                chosen_container = container
                break

        if not text_nodes:
            nodes = page.xpath(f"//body//text()[{NOISE_EXCLUDE}]").getall()
            text_nodes = [t.strip() for t in nodes if t.strip()]

        text = "\n".join(text_nodes)

        script_nodes = page.xpath(
            "//script[not(@src) and ("
            "not(@type) or @type='application/ld+json' "
            "or @type='text/javascript' or @type='module'"
            ")]//text()"
        ).getall()
        scripts_text = "\n".join(s.strip() for s in script_nodes if s.strip())

        img_srcs = page.css("img::attr(src)").getall()
        img_data_srcs = page.css("img::attr(data-src)").getall()
        images = list(dict.fromkeys(
            img for img in img_srcs + img_data_srcs
            if img and img.startswith("http")
        ))[:MAX_IMAGES]

        # Extract links from the same content container to avoid nav links
        hrefs = page.xpath(
            f"{chosen_container}//a[@href]/@href["
            f"not(ancestor::*[contains(@class,'navbox')]) and "
            f"not(ancestor::*[contains(@class,'sidebar')]) and "
            f"not(ancestor::*[@id='toc']) and "
            f"not(ancestor::nav) and not(ancestor::footer)"
            f"]"
        ).getall()
        links = resolve_links(url, hrefs)

        return ScrapeResult(
            url=url,
            title=title,
            text=text[:MAX_TEXT_LENGTH],
            scripts=scripts_text[:MAX_SCRIPTS_LENGTH],
            images=images,
            links=links,
        )
    except Exception as e:
        logger.error(f"Scraping failed for {url}: {e}")
        return ScrapeResult(url=url, error=str(e)[:500])


@app.post("/scrape")
async def scrape(req: ScrapeRequest) -> ScrapeResult:
    return await _scrape(req.url)


@app.post("/scrape-multiple")
async def scrape_multiple(req: MultiScrapeRequest) -> list[ScrapeResult]:
    urls = req.urls[:MAX_CONCURRENT]
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async def bounded(url: str) -> ScrapeResult:
        async with sem:
            return await _scrape(url)

    return list(await asyncio.gather(*[bounded(u) for u in urls]))

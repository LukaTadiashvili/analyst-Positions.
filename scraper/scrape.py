#!/usr/bin/env python3
"""ანალიტიკოსის ვაკანსიების შემგროვებელი.

აგროვებს ქართული ვაკანსიების საიტებიდან იმ ვაკანსიებს, რომელთა დასახელებაშიც
ანალიტიკოსი / BI / აუდიტი / რეპორტინგი ურევია, აერთიანებს დუბლიკატებს,
ამოიღებს მოკლე შეჯამებას და წერს site/data/jobs.json-ში.

მხოლოდ Python-ის სტანდარტულ ბიბლიოთეკას იყენებს (დამატებითი პაკეტები არ სჭირდება).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "site", "data")
JOBS_FILE = os.path.join(DATA_DIR, "jobs.json")
META_FILE = os.path.join(DATA_DIR, "meta.json")
CACHE_FILE = os.path.join(ROOT, "scraper", "cache.json")  # არ ქვეყნდება საიტზე

UA = "AnalystJobsAggregator/1.0 (personal job-search helper; daily)"
TBILISI = dt.timezone(dt.timedelta(hours=4))
NOW = dt.datetime.now(TBILISI)
TODAY = NOW.date()
KEEP_INACTIVE_DAYS = 120

# ---------------------------------------------------------------- matching

TITLE_RE = re.compile(
    r"ანალიტიკ|ანალიზ|analyst|analytic|\bBI\b|business intelligence|data scien|"
    r"მონაცემთა მეცნიერ|აუდიტ|audit|რეპორტინგ|reporting|ანგარიშგებ",
    re.I,
)
EXCLUDE_RE = re.compile(r"ლაბორა|laborator|ექთან|სისხლ|ქიმიურ|აუდიტორიის|ღამის აუდიტ|night audit|აუდიტი/ადმინისტრატორ", re.I)

SEARCH_TERMS = [
    "ანალიტიკოსი", "ანალიტიკ", "ანალიტიკა", "analyst", "analytics", "ანალიზ",
    "BI", "აუდიტ", "audit", "რეპორტინგ", "reporting", "data",
]


def is_analyst_title(title: str) -> bool:
    return bool(title) and bool(TITLE_RE.search(title)) and not EXCLUDE_RE.search(title)


# ---------------------------------------------------------------- http

def fetch(url: str, *, data: bytes | None = None, headers: dict | None = None,
          timeout: int = 40, retries: int = 2) -> str:
    h = {"User-Agent": UA, "Accept-Language": "ka,en;q=0.8"}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                charset = r.headers.get_content_charset() or "utf-8"
            time.sleep(0.35)  # თავაზიანი ტემპი საიტების მიმართ
            return raw.decode(charset, errors="replace").lstrip("﻿")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:  # noqa: PERF203
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code in (401, 403, 404):
                break
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def fetch_json(url: str, **kw):
    return json.loads(fetch(url, headers={"Accept": "application/json"}, **kw))


def q(s: str) -> str:
    return urllib.parse.quote(s)


# ---------------------------------------------------------------- text helpers

def html_to_lines(fragment: str) -> list[str]:
    if not fragment:
        return []
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", fragment)
    s = re.sub(r"(?i)<li[^>]*>", "\n• ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>|<h\d[^>]*>|</tr>|<p[^>]*>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s).replace("\xa0", " ").replace("​", "")
    lines = []
    for ln in s.split("\n"):
        ln = re.sub(r"\s+", " ", ln).strip()
        if ln and ln not in ("•", "-", "*"):
            lines.append(ln)
    return lines


def html_to_text(fragment: str) -> str:
    return "\n".join(html_to_lines(fragment))


def clean(s) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(s or ""))).strip()


GE_MONTHS = {
    "იანვ": 1, "თებ": 2, "მარ": 3, "აპრ": 4, "მაი": 5, "ივნ": 6, "ივლ": 7,
    "აგვ": 8, "სექ": 9, "ოქტ": 10, "ნოე": 11, "დეკ": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
    "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def parse_day_month(s: str):
    m = re.search(r"(\d{1,2})\s+([^\s\d]+)", s or "")
    if not m:
        return None
    word = m.group(2).lower()
    for k, v in GE_MONTHS.items():
        if word.startswith(k):
            return int(m.group(1)), v
    return None


def infer_dates(pub_s: str, dl_s: str):
    """jobs.ge-ზე თარიღებს წელი არ აქვს — ვადგენთ დღევანდელი დღიდან."""
    pub = dl = None
    pm = parse_day_month(pub_s)
    if pm:
        d, m = pm
        y = TODAY.year if m <= TODAY.month + 1 else TODAY.year - 1
        try:
            pub = dt.date(y, m, d)
        except ValueError:
            pub = None
    dm = parse_day_month(dl_s)
    if dm:
        d, m = dm
        base = pub or TODAY
        y = base.year if m >= base.month else base.year + 1
        try:
            dl = dt.date(y, m, d)
        except ValueError:
            dl = None
    return iso(pub), iso(dl)


def iso(d) -> str | None:
    if not d:
        return None
    if isinstance(d, (dt.date, dt.datetime)):
        return d.strftime("%Y-%m-%d")
    m = re.match(r"(\d{4}-\d{2}-\d{2})", str(d))
    return m.group(1) if m else None


# ---------------------------------------------------------------- enrichment

SKILLS = [
    ("SQL", r"\bSQL\b|T-SQL|PL/SQL|MS ?SQL|PostgreSQL|MySQL"),
    ("Excel", r"\bExcel\b|ექსელ|MS Office|Microsoft Office"),
    ("Power BI", r"Power ?BI"),
    ("Tableau", r"Tableau"),
    ("Python", r"Python|პითონ|pandas"),
    ("R", r"(?<![\w&/-])R(?=\s*(?:,|/|\)|და\s|ან\s|or\s|and\s|programming|studio))|RStudio"),
    ("SAS", r"\bSAS\b"),
    ("SPSS", r"SPSS"),
    ("STATA", r"\bSTATA\b|\bStata\b"),
    ("VBA", r"\bVBA\b|მაკრო|Macros?"),
    ("DAX", r"\bDAX\b"),
    ("Power Query", r"Power ?Query"),
    ("Looker", r"Looker"),
    ("Qlik", r"Qlik"),
    ("Google Analytics", r"Google Analytics|\bGA4\b"),
    ("ETL", r"\bETL\b|\bELT\b"),
    ("DWH", r"\bDWH\b|data ?warehouse|მონაცემთა საწყობ"),
    ("Oracle", r"Oracle"),
    ("SAP", r"\bSAP\b"),
    ("1C", r"\b1[CС]\b"),
    ("Jira", r"\bJira\b"),
    ("BPMN", r"BPMN"),
    ("UML", r"\bUML\b"),
    ("IFRS", r"IFRS|ფასს|ფინანსური ანგარიშგების საერთაშორისო სტანდარტ"),
    ("ფინ. მოდელირება", r"financial model|ფინანსური მოდელ|DCF|ფინანსური მოდელირ"),
    ("სტატისტიკა", r"სტატისტიკ|statistic"),
    ("Machine Learning", r"machine learning|მანქანური სწავლ|\bML\b"),
    ("Spark", r"\bSpark\b|PySpark"),
    ("Airflow", r"Airflow"),
    ("Git", r"\bGit\b|GitHub|GitLab"),
    ("A/B ტესტირება", r"A/B"),
    ("CRM", r"\bCRM\b"),
    ("Agile/Scrum", r"Agile|Scrum"),
    ("API", r"\bAPI\b|REST"),
    ("Cloud", r"\bAWS\b|Azure|GCP|BigQuery|Snowflake"),
]
SKILL_RES = [(n, re.compile(p, re.I if n not in ("R", "SAS", "1C") else 0)) for n, p in SKILLS]

LANGS = [
    ("ინგლისური", r"ინგლისურ|english"),
    ("რუსული", r"რუსულ|russian"),
    ("გერმანული", r"გერმანულ|german"),
    ("თურქული", r"თურქულ|turkish"),
    ("ფრანგული", r"ფრანგულ|french"),
]

DIRECTIONS = [
    ("აუდიტი", r"აუდიტ|audit"),
    ("კიბერუსაფრთხოება", r"უსაფრთხოებ|security|\bSOC\b|კიბერ"),
    ("რისკი / საკრედიტო", r"რისკ|risk|საკრედიტო|credit|კორპორატიულ|სარეაბილიტაციო|სექტორ|ინდუსტრი|fraud|თაღლით|\bAML\b|compliance|შესაბამისობ"),
    ("მონაცემები / BI", r"მონაცემ|data|oracle|\bBI\b|business intelligence|რეპორტინგ|reporting|ანგარიშგებ|რაოდენობრივ|quant"),
    ("ფინანსური", r"ფინანს|financ|ბიუჯეტ|budget|FP&A|ინვესტ|invest|M&A|treasury|ხაზინ|სტრატეგიულ"),
    ("მარკეტინგი / გაყიდვები", r"მარკეტინგ|marketing|გაყიდვ|sales|commercial|კომერციულ|pricing|ფასწარმოქმ|CRM|ბრენდ"),
    ("ოპერაციები / მიწოდება", r"შესყიდვ|procurement|მარაგ|supply|საწყობ|ლოჯისტ|logistic|operation|საოპერაციო|აღწერ|ქსელის"),
    ("ბიზნეს / სისტემური", r"ბიზნეს|business|სისტემ|system|\bIT\b|პროდუქტ|product|პროცეს|process"),
]


def detect_direction(title: str) -> str:
    for name, pat in DIRECTIONS:
        if re.search(pat, title, re.I):
            return name
    return "სხვა"


def detect_level(title: str, text: str, exp_years, hint: str = "") -> str:
    t = f"{title} {hint}".lower()
    if re.search(r"სტაჟიორ|სტაჟირებ|intern|trainee|სტუდენტ", t):
        return "სტაჟირება"
    if re.search(r"junior|უმცროს|დამწყებ|entry", t):
        return "Junior"
    if re.search(r"senior|უფროს|წამყვან|lead|head|ხელმძღვანელ|მთავარ|principal|director|დირექტორ|associate director|mid-senior", t):
        return "Senior"
    if re.search(r"middle|mid-level|mid level|საშუალო", t):
        return "Middle"
    if exp_years is not None:
        if exp_years <= 1:
            return "Junior"
        if exp_years >= 5:
            return "Senior"
    return "Middle"


EXP_RE = re.compile(
    r"(\d{1,2})(?:\s*(?:-|–|—)\s*\d{1,2})?\s*\+?\s*-?\s*(?:წლიანი|წლის|წელი|წლ|year|yr)",
    re.I,
)


def detect_experience(text: str):
    best = None
    for ln in text.split("\n"):
        if not re.search(r"გამოცდილ|experience|სტაჟ", ln, re.I):
            continue
        for m in EXP_RE.finditer(ln):
            n = int(m.group(1))
            if 0 < n <= 15:
                best = n if best is None else min(best, n)
    return best


SAL_RE = re.compile(
    r"(?P<a>\d{1,3}(?:[ ,.]?\d{3})|\d{3,5})\s*(?:(?:-|–|—|დან)\s*(?P<b>\d{1,3}(?:[ ,.]?\d{3})|\d{3,5}))?\s*"
    r"(?P<c>₾|ლარ|GEL|gel|\$|USD|usd|€|EUR|eur|დოლარ|ევრო)",
)


SAL_LINE_RE = re.compile(r"(?:ხელფას|ანაზღაურებ|salary)[^\d]{0,25}(\d{3,5})(?:\s*(?:-|–|—)\s*(\d{3,5}))?", re.I)


def detect_salary_in_text(text: str):
    text = re.sub(r"(\d)[,.]\s(\d{3})\b", r"\1\2", text)
    for ln in text.split("\n"):
        if not re.search(r"ხელფას|ანაზღაურებ|salary|ანაზღაურება|compensation|₾|ლარ", ln, re.I):
            continue
        m = SAL_RE.search(ln)
        if m:
            a = int(re.sub(r"\D", "", m.group("a")))
            b = int(re.sub(r"\D", "", m.group("b"))) if m.group("b") else None
            if 300 <= a <= 60000 and (b is None or a <= b <= 100000):
                return make_salary(a, b, m.group("c"))
        m = SAL_LINE_RE.search(ln)
        if m:
            a, b = int(m.group(1)), int(m.group(2)) if m.group(2) else None
            if 400 <= a <= 60000 and (b is None or a <= b <= 100000):
                return make_salary(a, b, "₾")
    return None


def currency(c: str | None) -> str:
    c = (c or "").lower()
    if c in ("$", "usd") or "დოლარ" in c:
        return "$"
    if c in ("€", "eur") or "ევრო" in c:
        return "€"
    return "₾"


def make_salary(a, b=None, cur=None):
    try:
        a = int(float(a)) if a not in (None, "", 0, "0") else None
        b = int(float(b)) if b not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        return None
    if not a and not b:
        return None
    return {"from": a, "to": b, "cur": currency(cur)}


HEADINGS = {
    "duties": r"მოვალეობ|ფუნქცი|პასუხისმგებლობ|რას გააკეთებ|რას აკეთებ|საქმიანობ|ამოცან|დავალებ|responsibilit|duties|what you.?ll do|what you will do|your role|role overview|tasks|key accountabilit|job description",
    "reqs": r"მოთხოვნ|საკვალიფიკაციო|კვალიფიკაცი|უნდა გქონდე|ვეძებთ|კანდიდატ|requirement|qualification|what we.?re looking|who you are|must have|skills|უნარ|ცოდნა|გამოცდილება და",
    "offers": r"გთავაზობ|შეთავაზებ|ბენეფიტ|benefit|we offer|what we offer|perks|რას მიიღებ|სარგებელ|პირობები",
}
HEADING_RES = {k: re.compile(v, re.I) for k, v in HEADINGS.items()}
NOISE_RE = re.compile(
    r"პერსონალურ მონაცემ|დაგიკავშირდებ|დაგიკავშირებ|^მაინტერესებს$|გამოაგზავნ|ელ\.? ?ფოსტ|კანონის|"
    r"დისკრიმინაცი|discrimin|personal data|apply now|გამოგზავნ|განაცხადის შევსებ|ბმულზე|შერჩევის პროცეს",
    re.I)


def summarize(text: str) -> dict:
    lines = [ln for ln in text.split("\n") if ln.strip()]
    sections = {"about": [], "duties": [], "reqs": [], "offers": []}
    cur = "about"
    for ln in lines:
        plain = ln.lstrip("•-*·▪● ").strip()
        is_heading = (
            len(plain) <= 90
            and not ln.startswith("•")
            and (plain.endswith(":") or len(plain) <= 50)
        )
        switched = False
        if is_heading:
            for key, rx in HEADING_RES.items():
                if rx.search(plain):
                    cur = key
                    switched = True
                    break
        if switched:
            continue
        if len(plain) < 3:
            continue
        sections[cur].append(plain)

    def pick(items, n, maxlen=170):
        out = []
        for it in items:
            if it.endswith(":") or NOISE_RE.search(it):
                continue
            it = it.rstrip(";,. ")
            if len(it) > maxlen:
                it = it[: maxlen - 1].rsplit(" ", 1)[0] + "…"
            if it and it not in out:
                out.append(it)
            if len(out) >= n:
                break
        return out

    about = " ".join(sections["about"])
    about = re.sub(r"\s+", " ", about).strip()
    if len(about) > 260:
        about = about[:259].rsplit(" ", 1)[0] + "…"
    res = {
        "about": about,
        "duties": pick(sections["duties"], 6),
        "reqs": pick(sections["reqs"], 7),
        "offers": pick(sections["offers"], 5),
    }
    # თუ სტრუქტურა ვერ ვიპოვეთ — პირველი რამდენიმე წინადადება
    if not (res["duties"] or res["reqs"]) and len(sections["about"]) > 2:
        res["about"] = pick(sections["about"], 1, 260)[0] if sections["about"] else ""
        res["duties"] = pick(sections["about"][1:], 6)
    return res


def detect_remote(text: str, flag=None) -> str | None:
    if flag in ("remote", "hybrid"):
        return flag
    t = text.lower()
    if re.search(r"ჰიბრიდ|hybrid", t):
        return "hybrid"
    if re.search(r"დისტანციურ|remote|სახლიდან მუშაობ|work from home", t):
        return "remote"
    return None


def enrich(job: dict, text: str, extra: dict | None = None) -> dict:
    extra = extra or {}
    full = f"{job['title']}\n{text}"
    skills = [n for n, rx in SKILL_RES if rx.search(full)]
    langs = [x for x in (extra.get("languages") or []) if x != "ქართული"]
    for n, p in LANGS:
        if n not in langs and re.search(p, text, re.I):
            langs.append(n)
    exp = extra.get("exp")
    if exp is None:
        exp = detect_experience(text)
    if not job.get("salary"):
        job["salary"] = detect_salary_in_text(text)
    job["skills"] = skills
    job["languages"] = langs
    job["exp"] = exp
    job["level"] = detect_level(job["title"], text, exp, extra.get("levelHint", ""))
    job["direction"] = detect_direction(job["title"])
    job["remote"] = detect_remote(f"{job['title']}\n{text}", extra.get("remote"))
    summ = summarize(text)
    if extra.get("offers") and not summ["offers"]:
        summ["offers"] = extra["offers"][:6]
    job["summary"] = summ
    job["textLen"] = len(text)
    return job


# ---------------------------------------------------------------- sources
# თითოეული წყარო აბრუნებს "raw" ჩანაწერების სიას:
# {sid, site, title, company, logo, url, published, deadline, salary, location, text, extra}

def src_jobs_ge(cache):
    found = {}
    for term in SEARCH_TERMS:
        page = fetch(f"https://jobs.ge/ge/?page=1&q={q(term)}&cid=&lid=&jid=")
        for row in re.findall(r"(?s)<tr>(.*?)</tr>", page):
            m = re.search(r'view=jobs&id=(\d+)"[^>]*>([^<]+)</a>', row)
            if not m:
                continue
            jid, title = m.group(1), clean(m.group(2))
            if jid in found or not is_analyst_title(title):
                continue
            tds = re.findall(r"(?s)<td[^>]*>(.*?)</td>", row)
            company = clean(re.sub(r"<[^>]+>", " ", tds[3])) if len(tds) > 3 else ""
            logo = re.search(r'src="(/data/clients/logo_icon/[^"]+)"', row)
            loc = re.search(r"<i>\s*-\s*([^<]+)</i>", row)
            pub, dl = infer_dates(clean(re.sub("<[^>]+>", "", tds[4])) if len(tds) > 4 else "",
                                  clean(re.sub("<[^>]+>", "", tds[5])) if len(tds) > 5 else "")
            found[jid] = {
                "sid": f"jobsge:{jid}", "site": "jobs.ge", "title": title, "company": company,
                "logo": f"https://jobs.ge{logo.group(1)}" if logo else None,
                "url": f"https://jobs.ge/ge/?view=jobs&id={jid}",
                "published": pub, "deadline": dl, "salary": None,
                "location": clean(loc.group(1)) if loc else "თბილისი",
                "hasSalaryFlag": "salary.gif" in row,
            }
    out = []
    for jid, j in found.items():
        c = cache.get(j["sid"])
        if c and c.get("text") is not None:
            j["text"] = c["text"]
        else:
            try:
                d = fetch(j["url"])
                m = re.search(r'(?s)<td style="padding-top:30px; padding-bottom:40px;">(.*?)</td>\s*</tr>\s*</table>', d)
                j["text"] = html_to_text(m.group(1)) if m else ""
            except Exception as e:  # noqa: BLE001
                print("  jobs.ge detail fail", jid, e)
                j["text"] = ""
        out.append(j)
    return out


def _hr_state(page: str):
    m = re.search(r'(?s)<script id="ng-state"[^>]*>(.*?)</script>', page)
    return json.loads(m.group(1)) if m else {}


def _hr_find(state: dict, needle: str):
    for v in state.values():
        if isinstance(v, dict) and needle in str(v.get("u", "")):
            return v.get("b", {}).get("data")
    return None


def _hr_detail(host: str, aid, cache_key, cache):
    c = cache.get(cache_key)
    if c and c.get("text") is not None and c.get("detail"):
        return c["detail"], c["text"]
    page = fetch(f"https://{host}/announcement/{aid}")
    data = _hr_find(_hr_state(page), f"/announcement/{aid}") or {}
    a = data.get("announcement") or {}
    text = html_to_text(html.unescape(a.get("description") or ""))
    detail = {
        "salaryFrom": a.get("salaryFrom"), "salaryTo": a.get("salaryTo"),
        "languages": a.get("languages") or [], "benefits": a.get("benefits") or [],
        "wfh": a.get("isWorkFromHome"), "empForm": a.get("employmentFormTypeName"),
        "expFrom": a.get("workExperienceFrom"), "logo": a.get("customerLogoUrl") or a.get("logoUrl"),
        "company": a.get("customerName"), "addresses": a.get("addresses") or [],
        "publish": a.get("publishDate"), "deadline": a.get("deadlineDate"), "title": a.get("title"),
        "anonymous": a.get("isAnonymous"),
    }
    return detail, text


def _hr_like(host: str, site: str, prefix: str, cache):
    found = {}
    for term in SEARCH_TERMS:
        page = fetch(f"https://{host}/search-posting?q={q(term)}")
        data = _hr_find(_hr_state(page), "announcement-search") or {}
        for it in (data.get("announcements") or {}).get("items") or []:
            title = clean(it.get("title"))
            aid = it.get("announcementId")
            if not aid or aid in found or not is_analyst_title(title):
                continue
            found[aid] = it
    out = []
    for aid, it in found.items():
        key = f"{prefix}:{aid}"
        try:
            detail, text = _hr_detail(host, aid, key, cache)
        except Exception as e:  # noqa: BLE001
            print(f"  {site} detail fail", aid, e)
            detail, text = {}, ""
        sal = make_salary(detail.get("salaryFrom"), detail.get("salaryTo"), "₾")
        company = clean(detail.get("company") or it.get("customerName"))
        if it.get("isAnonymous") or detail.get("anonymous"):
            company = company or "ანონიმური კომპანია"
        out.append({
            "sid": key, "site": site, "title": clean(it.get("title")), "company": company,
            "logo": detail.get("logo") or it.get("logoFilename"),
            "url": f"https://{host}/announcement/{aid}",
            "published": iso(it.get("publishDate")), "deadline": iso(it.get("deadlineDate")),
            "salary": sal, "location": ", ".join(it.get("locations") or detail.get("addresses") or []),
            "text": text, "detail": detail,
            "extra": {
                "languages": detail.get("languages"), "offers": detail.get("benefits"),
                "remote": "remote" if (it.get("isWorkFromHome") or detail.get("wfh")) else None,
                "exp": detail.get("expFrom"),
            },
        })
    return out


def src_hr_ge(cache):
    return _hr_like("www.hr.ge", "hr.ge", "hrge", cache)


def src_cv_ge(cache):
    return _hr_like("www.cv.ge", "cv.ge", "cvge", cache)


def src_myjobs(cache):
    found = {}
    for term in SEARCH_TERMS:
        page = 1
        while page <= 6:
            d = fetch_json(f"https://api.myjobs.ge/api/ka/public/vacancies?keyword={q(term)}&page={page}")
            for v in d.get("data") or []:
                title = clean(v.get("title"))
                if v["id"] in found or not is_analyst_title(title):
                    continue
                found[v["id"]] = v
            last = (d.get("meta") or {}).get("last_page") or 1
            if page >= last:
                break
            page += 1
    out = []
    for vid, v in found.items():
        comp = v.get("company") or {}
        sub = v.get("sub_brand") or {}
        company = clean(sub.get("brand_name") or comp.get("brand_name") or v.get("recruiter_company_name"))
        logo = None
        if sub.get("logo_path"):
            logo = sub["logo_path"] if str(sub["logo_path"]).startswith("http") else f"https://static.tnet.ge/{sub['logo_path'].lstrip('/')}"
        elif comp.get("has_logo"):
            logo = f"https://static.tnet.ge/myjobs/company/{v.get('company_id')}.jpg?v={comp.get('logo_version') or 0}"
        created = v.get("created_at")
        pub = iso(created)
        dl = None
        if pub and v.get("duration"):
            dl = iso(dt.date.fromisoformat(pub) + dt.timedelta(days=int(v["duration"])))
        sal = None
        if v.get("show_salary") and v.get("salary_type") != "negotiable":
            sal = make_salary(v.get("salary_from"), v.get("salary_to"), "₾")
        city = ((v.get("country") or {}).get("city") or {}).get("title") or ""
        jt = v.get("job_type")
        hint = " ".join(e.get("experience_level", "") for e in (v.get("experience_levels") or []) if isinstance(e, dict))
        hint += " " + str(v.get("experience_level") or "")
        out.append({
            "sid": f"myjobs:{vid}", "site": "myjobs.ge", "title": clean(v.get("title")), "company": company,
            "logo": logo, "url": f"https://www.myjobs.ge/ka/vacancy/{vid}",
            "published": pub, "deadline": dl, "salary": sal, "location": city,
            "text": html_to_text(v.get("description") or ""),
            "extra": {
                "remote": "remote" if jt == "remote" else ("hybrid" if jt == "hybrid" else None),
                "levelHint": hint.replace("mid-level", "middle").replace("entry", "junior"),
                "offers": [b.get("title") if isinstance(b, dict) else str(b) for b in (v.get("benefits_translated") or [])],
            },
        })
    return out


def _wp_jobboard(base: str, site: str, prefix: str):
    found = {}
    for term in SEARCH_TERMS:
        try:
            items = fetch_json(f"{base}/wp-json/wp/v2/job_listing?per_page=100&search={q(term)}")
        except Exception as e:  # noqa: BLE001
            print(f"  {site} search fail {term}: {e}")
            continue
        if not isinstance(items, list):
            continue
        for it in items:
            title = clean((it.get("title") or {}).get("rendered"))
            if it["id"] in found or not is_analyst_title(title):
                continue
            found[it["id"]] = it
    out = []
    for wid, it in found.items():
        m = it.get("metas") or {}
        loc = m.get("_job_location")
        loc = ", ".join(loc.values()) if isinstance(loc, dict) else (m.get("_job_address") or "")
        sal = None
        if m.get("_job_salary"):
            nums = re.findall(r"\d{3,6}", str(m.get("_job_salary")))
            if nums:
                sal = make_salary(nums[0], nums[1] if len(nums) > 1 else None, "₾")
        out.append({
            "sid": f"{prefix}:{wid}", "site": site, "title": clean(it["title"]["rendered"]),
            "company": clean(m.get("_job_employer_name")), "logo": m.get("_job_logo") or None,
            "url": it.get("link"), "published": iso(it.get("date")),
            "deadline": iso(m.get("_job_application_deadline_date") or m.get("_job_expiry_date")),
            "salary": sal, "location": loc,
            "text": html_to_text((it.get("content") or {}).get("rendered") or ""),
            "extra": {},
        })
    return out


def src_openjobs(cache):
    return _wp_jobboard("https://openjobs.ge", "openjobs.ge", "openjobs")


def src_unijobs(cache):
    return _wp_jobboard("https://unijobs.ge", "unijobs.ge", "unijobs")


def src_hh_ge(cache):
    """HH Recruitment — ვაკანსიები hr.ge-ს პლატფორმაზეა, დეტალებს იქიდან ვიღებთ."""
    found = {}
    for lang in ("ka", "en"):
        page = fetch(f"https://www.hh.ge/{lang}/vacancies/")
        for slug, inner in re.findall(r'(?s)<a[^>]+href="[^"]*hh_vacancy_slug=hh-(\d+)[^"]*"[^>]*>(.*?)</a>', page):
            title = clean(re.sub("<[^>]+>", " ", inner))
            if title in ("ვაკანსიის ნახვა", "View vacancy", "") or slug in found:
                continue
            if is_analyst_title(title):
                found[slug] = (title, lang)
    out = []
    for aid, (title, lang) in found.items():
        key = f"hhge:{aid}"
        try:
            detail, text = _hr_detail("www.hr.ge", aid, key, cache)
        except Exception as e:  # noqa: BLE001
            print("  hh.ge detail fail", aid, e)
            detail, text = {}, ""
        out.append({
            "sid": key, "site": "hh.ge", "title": clean(detail.get("title") or title),
            "company": clean(detail.get("company") or "HH Recruitment"),
            "logo": detail.get("logo"),
            "url": f"https://www.hh.ge/{lang}/?hh_vacancy_slug=hh-{aid}&hh_lang_code={lang}",
            "published": iso(detail.get("publish")), "deadline": iso(detail.get("deadline")),
            "salary": make_salary(detail.get("salaryFrom"), detail.get("salaryTo"), "₾"),
            "location": ", ".join(detail.get("addresses") or []), "text": text, "detail": detail,
            "extra": {"languages": detail.get("languages"), "offers": detail.get("benefits"),
                      "remote": "remote" if detail.get("wfh") else None, "exp": detail.get("expFrom")},
        })
    return out


def src_joob(cache):
    found = {}
    for term in ["ანალიტიკოსი", "ანალიტიკ", "analyst", "აუდიტ", "BI"]:
        page = fetch(f"https://joob.ge/?s={q(term)}")
        body = re.sub(r"(?is)<(script|style|svg)[^>]*>.*?</\1>", " ", page)
        for href, inner in re.findall(r'(?s)<a[^>]+href="(https://joob\.ge/[^"#?]+/)"[^>]*>(.*?)</a>', body):
            title = clean(re.sub("<[^>]+>", " ", inner))
            if not title or href in found or "/search/" in href or "/category/" in href:
                continue
            if is_analyst_title(title):
                found[href] = title
    out = []
    for href, title in found.items():
        key = "joob:" + hashlib.md5(href.encode()).hexdigest()[:10]
        c = cache.get(key)
        text, pub, logo = (c or {}).get("text"), (c or {}).get("published"), (c or {}).get("logo")
        if text is None:
            try:
                d = fetch(href)
                pm = re.search(r'article:published_time" content="([^"]+)"', d)
                pub = iso(pm.group(1)) if pm else None
                om = re.search(r'og:image" content="([^"]+)"', d)
                logo = om.group(1) if om else None
                cm = re.search(r'(?s)elementor-widget-theme-post-content.*?<div class="elementor-widget-container">(.*?)</div>\s*</div>', d)
                if cm:
                    text = html_to_text(cm.group(1))
                else:
                    dm = re.search(r'og:description" content="([^"]*)"', d)
                    text = clean(dm.group(1)) if dm else ""
            except Exception as e:  # noqa: BLE001
                print("  joob detail fail", href, e)
                text = ""
        out.append({
            "sid": key, "site": "joob.ge", "title": title, "company": "", "logo": logo,
            "url": href, "published": pub, "deadline": None, "salary": None, "location": "",
            "text": text or "", "extra": {},
        })
    return out


SR_COMPANIES = {"TBCBANK": "თიბისი"}


def src_smartrecruiters(cache):
    out = []
    for ident, cname in SR_COMPANIES.items():
        offset, items = 0, []
        while True:
            d = fetch_json(f"https://api.smartrecruiters.com/v1/companies/{ident}/postings?limit=100&offset={offset}")
            items += d.get("content") or []
            offset += 100
            if offset >= (d.get("totalFound") or 0) or offset > 1000:
                break
        for p in items:
            title = clean(p.get("name"))
            if not is_analyst_title(title):
                continue
            key = f"sr:{p['id']}"
            c = cache.get(key)
            text = c.get("text") if c else None
            if text is None:
                try:
                    det = fetch_json(f"https://api.smartrecruiters.com/v1/companies/{ident}/postings/{p['id']}")
                    secs = ((det.get("jobAd") or {}).get("sections")) or {}
                    parts = []
                    for sk, label in (("jobDescription", "მოვალეობები:"), ("qualifications", "მოთხოვნები:"),
                                      ("additionalInformation", "გთავაზობთ:")):
                        t = (secs.get(sk) or {}).get("text")
                        if t:
                            parts.append(label + "\n" + html_to_text(t))
                    comp = (secs.get("companyDescription") or {}).get("text")
                    text = (html_to_text(comp)[:400] + "\n" if comp else "") + "\n".join(parts)
                except Exception as e:  # noqa: BLE001
                    print("  smartrecruiters detail fail", p["id"], e)
                    text = ""
            loc = p.get("location") or {}
            out.append({
                "sid": key, "site": "TBC კარიერა", "title": title, "company": cname, "logo": None,
                "url": f"https://jobs.smartrecruiters.com/{ident}/{p['id']}",
                "published": iso(p.get("releasedDate")), "deadline": None, "salary": None,
                "location": loc.get("city") or "",
                "text": text,
                "extra": {"remote": "remote" if loc.get("remote") else ("hybrid" if loc.get("hybrid") else None),
                          "levelHint": ((p.get("experienceLevel") or {}).get("id") or "").replace("_", " ")},
            })
    return out


SOURCES = [
    ("jobs.ge", src_jobs_ge),
    ("hr.ge", src_hr_ge),
    ("myjobs.ge", src_myjobs),
    ("cv.ge", src_cv_ge),
    ("hh.ge", src_hh_ge),
    ("TBC კარიერა", src_smartrecruiters),
    ("openjobs.ge", src_openjobs),
    ("unijobs.ge", src_unijobs),
    ("joob.ge", src_joob),
]

# ---------------------------------------------------------------- merge

COMPANY_ALIASES = {
    "tbc": "თიბისი", "tbcbank": "თიბისი", "თიბისიბანკი": "თიბისი", "თიბისი": "თიბისი",
    "bankofgeorgia": "საქართველოსბანკი", "bog": "საქართველოსბანკი", "საქართველოსბანკი": "საქართველოსბანკი",
    "libertybank": "ლიბერთი", "ლიბერთიბანკი": "ლიბერთი", "ლიბერთი": "ლიბერთი",
    "procreditbank": "პროკრედიტი", "პროკრედიტბანკი": "პროკრედიტი",
}


def norm_company(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[\"'“”„«»()]", " ", s)
    s = re.sub(r"\b(სს|შპს|ს\.ს\.|შ\.პ\.ს\.|jsc|llc|ltd|inc)\b", " ", s)
    s = re.sub(r"[^\w]+", "", s)
    s2 = s.replace("ბანკი", "").replace("bank", "")
    return COMPANY_ALIASES.get(s, COMPANY_ALIASES.get(s2, s2 or s))


def norm_title(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^\w]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


TRANSLIT = dict(zip("აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ",
                    ["a","b","g","d","e","v","z","t","i","k","l","m","n","o","p","zh","r","s","t","u","p","k","gh","q","sh","ch","ts","dz","ts","ch","kh","j","h"]))


def latin_key(s: str) -> str:
    return "".join(TRANSLIT.get(ch, ch) for ch in norm_company(s))


def same_company(a: str, b: str) -> bool:
    x, y = latin_key(a), latin_key(b)
    if not x or not y:
        return False
    if x == y:
        return True
    short, long_ = sorted((x, y), key=len)
    return len(short) >= 4 and long_.startswith(short)


def merge_key(raw: dict) -> str:
    return norm_title(raw["title"]) + "|" + norm_company(raw["company"])


def job_id(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def build(raws: list[dict], previous: dict) -> dict:
    groups: dict[str, list[dict]] = {}
    # ანონიმური/უცნობი კომპანია — მხოლოდ საკუთარ ჯგუფში
    for r in raws:
        k = merge_key(r)
        if not norm_company(r["company"]):
            k += "|" + r["sid"]
        elif k not in groups:
            # იგივე დასახელება + მსგავსი კომპანია (მაგ. Ranko / რანკო) => ერთი ვაკანსია
            t = norm_title(r["title"])
            for gk, grp in groups.items():
                if gk.startswith(t + "|") and same_company(grp[0]["company"], r["company"]):
                    k = gk
                    break
        groups.setdefault(k, []).append(r)

    jobs = {}
    for k, rs in groups.items():
        rs.sort(key=lambda r: len(r.get("text") or ""), reverse=True)
        best = rs[0]
        jid = job_id(k)
        prev = previous.get(jid, {})
        pubs = [r["published"] for r in rs if r.get("published")]
        dls = [r["deadline"] for r in rs if r.get("deadline")]
        sal = next((r["salary"] for r in rs if r.get("salary")), None)
        logo = next((r["logo"] for r in rs if r.get("logo")), None)
        company = next((r["company"] for r in rs if r.get("company") and r["company"] != "კომპანია"), best["company"])
        loc = next((r["location"] for r in rs if r.get("location")), "")
        extra = {}
        for r in reversed(rs):
            for ek, ev in (r.get("extra") or {}).items():
                if ev not in (None, "", []):
                    extra[ek] = ev
        job = {
            "id": jid,
            "title": best["title"],
            "company": company or "—",
            "logo": logo,
            "salary": sal,
            "published": min(pubs) if pubs else prev.get("published") or iso(TODAY),
            "deadline": max(dls) if dls else None,
            "location": loc,
            "sources": [{"site": r["site"], "url": r["url"]} for r in rs],
            "url": best["url"],
            "firstSeen": prev.get("firstSeen") or NOW.isoformat(timespec="minutes"),
            "lastSeen": NOW.isoformat(timespec="minutes"),
            "active": True,
        }
        # ერთი და იგივე საიტიდან დუბლიკატი ლინკები არ გვჭირდება
        seen, srcs = set(), []
        for s in job["sources"]:
            if s["site"] not in seen:
                seen.add(s["site"])
                srcs.append(s)
        job["sources"] = srcs
        enrich(job, best.get("text") or "", extra)
        jobs[jid] = job
    return jobs


# ---------------------------------------------------------------- notify

def notify(new_jobs: list[dict], first_run: bool):
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic or not new_jobs:
        return
    site_url = os.environ.get("SITE_URL", "").rstrip("/")
    n = len(new_jobs)
    if first_run:
        title = f"აპი მზადაა — {n} ანალიტიკოსის ვაკანსია"
        body = "ამიერიდან ყოველდღე შეგატყობინებ ახალ ვაკანსიებზე."
    else:
        title = f"🆕 {n} ახალი ანალიტიკოსის ვაკანსია"
        lines = []
        for j in new_jobs[:8]:
            sal = ""
            if j.get("salary"):
                s = j["salary"]
                sal = f" · {s['from'] or ''}{'–' + str(s['to']) if s.get('to') else ''}{s['cur']}"
            lines.append(f"• {j['title']} — {j['company']}{sal}")
        if n > 8:
            lines.append(f"…და კიდევ {n - 8}")
        body = "\n".join(lines)
    payload = {"topic": topic, "title": title, "message": body, "tags": ["briefcase"], "priority": 4}
    if site_url:
        payload["click"] = f"{site_url}/#new"
    try:
        fetch("https://ntfy.sh/", data=json.dumps(payload).encode("utf-8"),
              headers={"Content-Type": "application/json"}, retries=1)
        print(f"ntfy: გაიგზავნა ({n})")
    except Exception as e:  # noqa: BLE001
        print("ntfy fail:", e)


# ---------------------------------------------------------------- main

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    prev_doc = load_json(JOBS_FILE, {"jobs": []})
    previous = {j["id"]: j for j in prev_doc.get("jobs", [])}
    first_run = not previous
    cache = load_json(CACHE_FILE, {})

    raws, status = [], []
    only = set(sys.argv[1:])
    for name, fn in SOURCES:
        if only and name not in only:
            continue
        t0 = time.time()
        try:
            items = fn(cache)
            raws += items
            status.append({"site": name, "ok": True, "count": len(items), "sec": round(time.time() - t0, 1)})
            print(f"✓ {name}: {len(items)}")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            status.append({"site": name, "ok": False, "count": 0, "error": str(e)[:200]})
            print(f"✗ {name}: {e}")

    current = build(raws, previous)
    ok_sites = {s["site"] for s in status if s["ok"]}

    # წინა ვაკანსიები, რომლებიც დღეს არ ჩანს
    for jid, old in previous.items():
        if jid in current:
            continue
        old = dict(old)
        dl = old.get("deadline")
        old_sites = {s["site"] for s in old.get("sources", [])}
        expired = bool(dl and dl < iso(TODAY))
        # თუ წყარო დღეს ვერ ჩაიტვირთა, ვაკანსიას აქტიურად ვტოვებთ
        if not expired and not (old_sites & ok_sites):
            current[jid] = old
            continue
        old["active"] = False
        last = (old.get("lastSeen") or "")[:10]
        if last and (TODAY - dt.date.fromisoformat(last)).days > KEEP_INACTIVE_DAYS:
            continue
        current[jid] = old

    for j in current.values():
        if j.get("deadline") and j["deadline"] < iso(TODAY):
            j["active"] = False

    new_jobs = [j for jid, j in current.items() if jid not in previous and j["active"]]
    new_jobs.sort(key=lambda j: j["published"] or "", reverse=True)

    jobs = sorted(current.values(), key=lambda j: (j.get("published") or "", j["firstSeen"]), reverse=True)

    # detail cache — რომ ყოველ დღე ყველა გვერდი თავიდან არ ჩამოვტვირთოთ
    new_cache = {}
    for r in raws:
        new_cache[r["sid"]] = {k: r.get(k) for k in ("text", "detail", "published", "logo") if r.get(k) is not None}

    with open(JOBS_FILE, "w", encoding="utf-8") as f:
        json.dump({"updated": NOW.isoformat(timespec="minutes"), "jobs": jobs}, f, ensure_ascii=False, indent=0)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(new_cache, f, ensure_ascii=False)
    meta = {
        "updated": NOW.isoformat(timespec="minutes"),
        "active": sum(1 for j in jobs if j["active"]),
        "total": len(jobs),
        "new": len(new_jobs),
        "newIds": [j["id"] for j in new_jobs],
        "sources": status,
    }
    with open(META_FILE, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print(f"სულ: {meta['active']} აქტიური, {meta['new']} ახალი")
    notify(new_jobs, first_run)


if __name__ == "__main__":
    main()

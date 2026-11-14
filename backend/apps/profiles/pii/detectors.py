"""Built-in PII detectors (registered on import).

Each detector is tuned for profile prose written by Indian students: it must
catch real identifiers, including lightly disguised ones, without blocking
ordinary write-ups (IP addresses, CVE ids, scores, years, version numbers).
Precision aids: check digits (Aadhaar Verhoeff, card Luhn + issuer prefix),
context keywords (bank account, PIN code, date of birth, passport) and strict
word boundaries. Every detector has positive and negative tests in
``tests/test_profiles_pii.py``.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from .checksums import luhn_valid, verhoeff_valid
from .engine import Detector, ScanContext, register
from .normalize import alnum_key, digits_only, normalize

_B = r"(?<![\w])"  # no word character before
_E = r"(?![\w])"  # no word character after
_IPV4 = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")


def _digits(value: str) -> str:
    return "".join(char for char in value if "0" <= char <= "9")


def _near(text: str, start: int, end: int, pattern: re.Pattern, before: int = 50, after: int = 25) -> bool:
    window = text[max(0, start - before) : min(len(text), end + after)]
    return bool(pattern.search(window))


def _inside_ipv4(text: str, start: int, end: int) -> bool:
    left = start
    while left > 0 and (text[left - 1].isdigit() or text[left - 1] == "."):
        left -= 1
    right = end
    while right < len(text) and (text[right].isdigit() or text[right] == "."):
        right += 1
    return bool(_IPV4.fullmatch(text[left:right]))


# ---------------------------------------------------------------------------
# Contact details
# ---------------------------------------------------------------------------
_TLDS = r"(?:com|in|org|net|co|io|edu|gov|ac|me|info|dev|xyz|app|uk|us|ai|biz)"
_KNOWN_MAIL = r"(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|proton|protonmail|pm|icloud|me|rediffmail|rediff|zoho|aol|gmx|yandex|mail|tutanota|fastmail)"


@register
class EmailDetector(Detector):
    code = "email"
    label = "an email address"
    priority = 80
    advice = "Remove it, then publish again. Share contact details privately, never on your profile."
    patterns = (
        # plain: name@example.com
        re.compile(r"(?<![\w.+\-])[\w.+\-]{1,64}@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,24}(?![\w\-])", re.I),
        # spaced @ (dots kept): name @ example.com
        re.compile(r"(?<![\w.+\-])[\w.+\-]{1,64}\s+@\s*[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,24}(?![\w\-])", re.I),
        # bracketed: name [at] example [dot] com / name(at)example.com / name {@} example . com
        re.compile(
            r"(?<![\w.+\-])[\w.+\-]{1,64}\s*[\[\(\{<]\s*(?:at|@)\s*[\]\)\}>]\s*[a-z0-9\-]{1,63}"
            r"(?:\s*(?:[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]|\.|\s+dot\s+)\s*[a-z0-9\-]{1,63})+",
            re.I,
        ),
        # spelled out: name at gmail dot com
        re.compile(rf"(?<![\w.+\-])[\w.+\-]{{2,64}}\s+at\s+[a-z0-9\-]{{2,63}}\s+dot\s+{_TLDS}{_E}", re.I),
        # spaced dots with a well-known provider: name @ gmail . com
        re.compile(rf"(?<![\w.+\-])[\w.+\-]{{1,64}}\s*@\s*{_KNOWN_MAIL}\s*\.\s*[a-z]{{2,6}}{_E}", re.I),
    )

    def find(self, text, ctx):
        for pattern in self.patterns:
            for match in pattern.finditer(text):
                yield match.start(), match.end()


_UPI_HANDLES = (
    "okaxis|okhdfcbank|okicici|oksbi|ybl|ibl|axl|paytm|ptyes|ptaxis|pthdfc|ptsbi|upi|apl|yapl|rapl|abfspay|"
    "axisbank|axisb|icici|sbi|hdfcbank|kotak|kmbl|airtel|airtelpaymentsbank|freecharge|jio|waicici|wahdfc|"
    "waaxis|wasbi|idfcbank|idfcfirst|indus|federal|fbl|aubank|yesbank|yesbankltd|barodampay|unionbankofindia|"
    "pnb|cnrb|boi|cbin|ikwik|mahb|dbs|hsbc|citi|sc|timecosmos|slice|fam|jupiteraxis|naviaxis|amazonpay|apay"
)


@register
class UpiDetector(Detector):
    code = "upi_id"
    label = "a UPI ID"
    priority = 78
    advice = "Remove it, then publish again. Payment IDs must never be public."
    pattern = re.compile(rf"(?<![\w.+\-])[\w.\-]{{2,256}}\s*@\s*(?:{_UPI_HANDLES}){_E}(?!\.[a-z])", re.I)

    def find(self, text, ctx):
        for match in self.pattern.finditer(text):
            yield match.start(), match.end()


_PHONE_KEYWORDS = re.compile(
    r"(?i)\b(?:phone|mobile|mob|cell|whats\s?app|wa|call(?:\s+me)?|tel|telephone|ph|contact|reach\s+me|ring|text\s+me|sms|signal|telegram)\b"
)


@register
class PhoneDetector(Detector):
    code = "phone"
    label = "a phone number"
    priority = 70
    advice = "Remove it, then publish again. Share contact details privately, never on your profile."
    # Indian mobile: optional +91 / 0091 / 91 / 0 prefix, then 10 digits starting 6-9 (groupings 10, 5-5, 3-3-4, 4-3-3, 2-4-4).
    indian = re.compile(
        r"(?<![\w+])(?:(?:\+|00)\s?91[\s\-]?|91[\s\-]?|0)?"
        r"(?:[6-9]\d{9}|[6-9]\d{4}[\s\-]\d{5}|[6-9]\d{2}[\s\-]\d{3}[\s\-]\d{4}|[6-9]\d{3}[\s\-]\d{3}[\s\-]\d{3}|[6-9]\d[\s\-]\d{4}[\s\-]\d{4})"
        r"(?![\w])"
    )
    # International (E.164-like): + or 00, country code, 2-6 groups; 8-15 digits in all.
    international = re.compile(r"(?<![\w+])(?:\+|00)\s?[1-9]\d{0,2}(?:[\s.\-]?\(?\d{1,5}\)?){2,6}(?![\w])")
    # Indian landline with STD code: 0 + 10 digits.
    landline = re.compile(r"(?<![\w+])\(?0\d{2,4}\)?[\s\-]?\d{6,8}(?![\w])")
    # Any number introduced by a phone keyword: "WhatsApp: 4471 234 567".
    keyword_number = re.compile(
        r"(?i)\b(?:phone|mobile|mob|cell|whats\s?app|call(?:\s+me)?(?:\s+on)?|tel|telephone|ph|contact(?:\s+me)?|text\s+me(?:\s+on)?|sms)\b"
        r"\.?\s*(?:no\.?|number|num|#)?\s*(?:is|at|on)?\s*[:\-]?\s*(\+?\(?\d[\d\s().\-]{5,22}\d)"
    )

    def find(self, text, ctx):
        for match in self.indian.finditer(text):
            if len(_digits(match.group())) >= 10 and not _inside_ipv4(text, match.start(), match.end()):
                yield match.start(), match.end()
        for match in self.international.finditer(text):
            digits = _digits(match.group())
            if match.group().startswith("00"):
                digits = digits[2:]
            if 8 <= len(digits) <= 15:
                yield match.start(), match.end()
        for match in self.landline.finditer(text):
            if len(_digits(match.group())) == 11 and not _inside_ipv4(text, match.start(), match.end()):
                yield match.start(), match.end()
        for match in self.keyword_number.finditer(text):
            number = match.group(1)
            if len(_digits(number)) >= 7 and not _IPV4.fullmatch(number.strip()):
                yield match.start(1), match.end(1)


# ---------------------------------------------------------------------------
# Indian identity documents
# ---------------------------------------------------------------------------
_AADHAAR_KEYWORD = re.compile(r"(?i)\b(?:aadhaa?r|adhaa?r|uidai|uid|enrolment\s+id|vid)\b")


@register
class AadhaarDetector(Detector):
    code = "aadhaar"
    label = "an Aadhaar number"
    priority = 85
    advice = "Remove it, then publish again. Never share your Aadhaar number publicly."
    twelve = re.compile(rf"{_B}[2-9]\d{{3}}([\s\-]?)\d{{4}}\1\d{{4}}{_E}")
    sixteen = re.compile(rf"{_B}\d{{4}}([\s\-]?)\d{{4}}\1\d{{4}}\1\d{{4}}{_E}")
    keyword_any = re.compile(rf"{_B}\d{{4}}[\s\-]?\d{{4}}[\s\-]?\d{{4}}{_E}")

    def find(self, text, ctx):
        for pattern in (self.twelve, self.sixteen):
            for match in pattern.finditer(text):
                if verhoeff_valid(_digits(match.group())):
                    yield match.start(), match.end()
        # A 12-digit number right after "Aadhaar" is reported even with a typo in the check digit.
        for match in self.keyword_any.finditer(text):
            if _near(text, match.start(), match.end(), _AADHAAR_KEYWORD, before=40, after=0):
                yield match.start(), match.end()


@register
class PanDetector(Detector):
    code = "pan"
    label = "a PAN card number"
    priority = 60
    advice = "Remove it, then publish again. Tax IDs must never be public."
    pattern = re.compile(rf"{_B}[A-Za-z]{{3}}[ABCFGHLJPTabcfghljpt][A-Za-z]\d{{4}}[A-Za-z]{_E}")

    def find(self, text, ctx):
        for match in self.pattern.finditer(text):
            yield match.start(), match.end()


_PASSPORT_KEYWORD = re.compile(r"(?i)\bpass\s?port\b")


@register
class PassportDetector(Detector):
    code = "passport"
    label = "a passport number"
    priority = 50
    advice = "Remove it, then publish again. Travel documents must never be public."
    indian = re.compile(rf"{_B}[A-PR-WY][1-9]\d{{5}}[1-9]{_E}")
    indian_any_case = re.compile(rf"{_B}[A-Za-z][1-9]\d{{5}}[1-9]{_E}")
    keyword_token = re.compile(
        r"(?i)\bpass\s?port\b\.?\s*(?:no\.?|number|num|#)?\s*(?:is)?\s*[:\-]?\s*([A-Z0-9]{6,9})\b"
    )

    def find(self, text, ctx):
        for match in self.indian.finditer(text):
            yield match.start(), match.end()
        for match in self.indian_any_case.finditer(text):
            if _near(text, match.start(), match.end(), _PASSPORT_KEYWORD, before=40, after=0):
                yield match.start(), match.end()
        for match in self.keyword_token.finditer(text):
            if any(char.isdigit() for char in match.group(1)):
                yield match.start(1), match.end(1)


_GOV_KEYWORDS = (
    r"voter\s*id|voter\s*card|epic(?:\s*no)?|driving\s*licen[cs]e|dl\s*no|licen[cs]e\s*(?:no|number)|"
    r"ssn|social\s*security(?:\s*number)?|national\s*id|nin|ration\s*card|job\s*card|"
    r"roll\s*(?:no|number)|enrol(?:l)?ment\s*(?:no|number)|registration\s*(?:no|number)|reg\.?\s*no|"
    r"employee\s*id|emp\s*id|student\s*id|admission\s*(?:no|number)|abha(?:\s*(?:no|number|id))?|"
    r"health\s*id|uan|esic|pf\s*(?:no|number)|nrega"
)


@register
class GovernmentIdDetector(Detector):
    code = "government_id"
    label = "a government or institution ID number"
    priority = 55
    advice = "Remove it, then publish again. ID numbers must never be public."
    patterns = (
        re.compile(rf"{_B}[A-Z]{{3}}\d{{7}}{_E}"),  # voter ID (EPIC)
        re.compile(rf"{_B}[A-Za-z]{{2}}[\s\-]?\d{{2}}[\s\-]?(?:19|20)\d{{2}}[\s\-]?\d{{7}}{_E}"),  # driving licence
        re.compile(rf"{_B}\d{{2}}[A-Za-z]{{5}}\d{{4}}[A-Za-z][1-9A-Za-z][Zz][0-9A-Za-z]{_E}"),  # GSTIN (contains a PAN)
        re.compile(r"(?<![\w\-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w\-])"),  # US SSN
        re.compile(rf"{_B}[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{{2}}\s?\d{{2}}\s?\d{{2}}\s?[A-D]{_E}"),  # UK NINO
        re.compile(rf"{_B}\d{{2}}([\s\-])\d{{4}}\1\d{{4}}\1\d{{4}}{_E}"),  # ABHA health ID (14 digits, grouped)
    )
    keyword_token = re.compile(
        rf"(?i)\b(?:{_GOV_KEYWORDS})\b\.?\s*(?:no\.?|number|num|#|id)?\s*(?:is)?\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{{3,24}})"
    )

    def find(self, text, ctx):
        for pattern in self.patterns:
            for match in pattern.finditer(text):
                yield match.start(), match.end()
        for match in self.keyword_token.finditer(text):
            token = match.group(1)
            if sum(char.isdigit() for char in token) >= 3:
                yield match.start(1), match.end(1)


# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------
_CARD_PREFIX = re.compile(r"^(?:4|5[1-5]|2[2-7]|3[47]|3[068]|35|6011|64[4-9]|65|60|81|82|508|62)")


@register
class CardDetector(Detector):
    code = "card_number"
    label = "a payment card number"
    priority = 90
    advice = "Remove it, then publish again. Card numbers must never be public."
    pattern = re.compile(rf"{_B}(?:\d[\s\-]?){{12,18}}\d{_E}")

    def find(self, text, ctx):
        for match in self.pattern.finditer(text):
            digits = _digits(match.group())
            if 13 <= len(digits) <= 19 and _CARD_PREFIX.match(digits) and luhn_valid(digits):
                yield match.start(), match.end()


_IFSC_KEYWORD = re.compile(r"(?i)\bifsc\b")
_BANK_KEYWORD = re.compile(
    r"(?i)\b(?:bank|a/?c|acc(?:oun)?t?|acct|savings|current\s+account|account\s+(?:no|number)|beneficiary|neft|imps|rtgs)\b"
)


@register
class IfscDetector(Detector):
    code = "ifsc"
    label = "a bank IFSC code"
    priority = 65
    advice = "Remove it, then publish again. Bank details must never be public."
    pattern = re.compile(rf"{_B}([A-Za-z]{{4}})0([A-Za-z0-9]{{6}}){_E}")

    def find(self, text, ctx):
        for match in self.pattern.finditer(text):
            bank, branch = match.group(1), match.group(2)
            if (
                bank.isupper()
                or sum(char.isdigit() for char in branch) >= 3
                or _near(text, match.start(), match.end(), _IFSC_KEYWORD, before=30, after=0)
            ):
                yield match.start(), match.end()


@register
class BankAccountDetector(Detector):
    code = "bank_account"
    label = "a bank account number"
    priority = 45
    advice = "Remove it, then publish again. Bank details must never be public."
    number = re.compile(rf"{_B}\d(?:[\s\-]?\d){{8,17}}{_E}")

    def find(self, text, ctx):
        for match in self.number.finditer(text):
            if _inside_ipv4(text, match.start(), match.end()):
                continue
            if _near(text, match.start(), match.end(), _BANK_KEYWORD, before=45, after=0):
                yield match.start(), match.end()


# ---------------------------------------------------------------------------
# Location and birth date
# ---------------------------------------------------------------------------
_PLACES = (
    r"delhi|new\s+delhi|mumbai|bombay|kolkata|calcutta|chennai|madras|bengaluru|bangalore|hyderabad|secunderabad|"
    r"pune|ahmedabad|surat|jaipur|lucknow|kanpur|nagpur|indore|bhopal|patna|vadodara|ludhiana|agra|nashik|"
    r"faridabad|meerut|rajkot|varanasi|srinagar|aurangabad|dhanbad|amritsar|allahabad|prayagraj|ranchi|howrah|"
    r"coimbatore|jabalpur|gwalior|vijayawada|jodhpur|madurai|raipur|kota|guwahati|chandigarh|mysuru|mysore|"
    r"thiruvananthapuram|trivandrum|kochi|cochin|kozhikode|calicut|noida|gurgaon|gurugram|ghaziabad|dehradun|"
    r"bhubaneswar|cuttack|visakhapatnam|vizag|aligarh|bareilly|moradabad|saharanpur|gorakhpur|jammu|shimla|"
    r"maharashtra|karnataka|kerala|tamil\s+nadu|telangana|andhra\s+pradesh|uttar\s+pradesh|madhya\s+pradesh|"
    r"west\s+bengal|bihar|odisha|orissa|gujarat|rajasthan|punjab|haryana|assam|jharkhand|chhattisgarh|"
    r"uttarakhand|himachal|goa|manipur|meghalaya|mizoram|nagaland|tripura|sikkim|arunachal|ladakh|puducherry|"
    r"pondicherry|j\s*&\s*k"
)
_ADDRESS_WORDS = (
    r"address|addr|road|rd|street|st|lane|ln|avenue|ave|marg|nagar|colony|sector|sec|block|blk|phase|layout|"
    r"cross|main|chowk|gali|mohalla|enclave|vihar|bagh|puram|pur|ganj|bazaar|bazar|market|apartment|apartments|"
    r"apt|flat|house|h\.?\s?no|floor|tower|society|residency|near|opp|opposite|behind|beside|post|p\.?\s?o|"
    r"village|vill|tehsil|taluk|taluka|mandal|district|dist|city|town|state|pin|pincode|pin\s*code|zip|zipcode|"
    r"postal\s*code|landmark|ward|plot|khasra|door|d\.?\s?no"
)
_ADDRESS_CONTEXT = re.compile(rf"(?i)\b(?:{_ADDRESS_WORDS}|{_PLACES})\b")
_STREET_WORDS = (
    r"road|rd|street|st|lane|ln|avenue|ave|marg|nagar|colony|sector|layout|cross|chowk|gali|enclave|vihar|bagh|"
    r"puram|apartments?|residency|towers?|society|soc"
)


@register
class AddressDetector(Detector):
    code = "address"
    label = "a home address or PIN code"
    priority = 30
    advice = "Remove it, then publish again. Never share where you live."
    pin = re.compile(rf"{_B}[1-9]\d{{2}}\s?\d{{3}}{_E}")
    street = re.compile(
        rf"{_B}\d{{1,5}}[A-Za-z]?(?:\s?[/\-]\s?\d{{1,5}}[A-Za-z]?)*,?\s+(?:[A-Z][\w'.\-]*,?\s+){{0,3}}(?i:{_STREET_WORDS})\b\.?"
    )
    house = re.compile(
        r"(?i)\b(?:house|h\.?\s?no|flat|apt|apartment|plot|door|d\.?\s?no|khasra)\b\.?\s*(?:no\.?|number|#)?\s*[:#\-]?\s*"
        r"\d+[A-Za-z]?(?:\s?[/\-]\s?\d+[A-Za-z]?)*"
    )
    labelled = re.compile(
        r"(?i)(?<!ip\s)(?<!mac\s)(?<!email\s)(?<!e-mail\s)(?<!web\s)(?<!wallet\s)(?<!memory\s)(?<!bitcoin\s)(?<!ethereum\s)"
        r"\b(?:my\s+)?(?:home\s+|residential\s+|postal\s+|permanent\s+|current\s+)?address\s*(?:is|:|-)\s*([^\n]{6,120})"
    )

    def find(self, text, ctx):
        for match in self.pin.finditer(text):
            if _inside_ipv4(text, match.start(), match.end()):
                continue
            if _near(text, match.start(), match.end(), _ADDRESS_CONTEXT, before=60, after=20):
                yield match.start(), match.end()
        for pattern in (self.street, self.house):
            for match in pattern.finditer(text):
                yield match.start(), match.end()
        for match in self.labelled.finditer(text):
            value = match.group(1).strip()
            if _IPV4.match(value) or re.match(r"(?i)0x[0-9a-f]+|[0-9a-f]{2}(?::[0-9a-f]{2}){5}", value):
                continue
            yield match.start(1), match.end(1)


_MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_DATE = (
    rf"(?:\d{{1,2}}(?:st|nd|rd|th)?[\s/.\-]+(?:\d{{1,2}}|{_MONTH})(?:[\s/.\-,]+\d{{2,4}})?"
    rf"|{_MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?"
    rf"|\d{{4}}[\-/.]\d{{1,2}}[\-/.]\d{{1,2}}"
    rf"|(?:19|20)\d{{2}})"
)


@register
class DateOfBirthDetector(Detector):
    code = "date_of_birth"
    label = "a date of birth"
    priority = 40
    advice = "Remove it, then publish again. Your birth date helps identity thieves."
    pattern = re.compile(
        rf"(?i)\b(?:date\s+of\s+birth|d\.?\s?o\.?\s?b\.?|birth\s?date|birth\s?day|bday|b'day|born)\b"
        rf"\s*(?:is|was|on|in|:|\-|=)?\s*(?:on|in)?\s*[:\-]?\s*({_DATE})(?![\w])"
    )

    def find(self, text, ctx):
        for match in self.pattern.finditer(text):
            yield match.start(), match.end()


# ---------------------------------------------------------------------------
# The owner's own identity (account name, email and phone)
# ---------------------------------------------------------------------------
def _name_tokens(full_name: str) -> list[str]:
    return [token for token in re.findall(r"[^\W\d_]+", normalize(full_name).casefold()) if len(token) >= 2]


@register
class OwnIdentityDetector(Detector):
    code = "own_identity"
    label = "your real name, email or phone number"
    priority = 100
    advice = (
        "Profiles show your public handle, not who you are. Remove it, then publish again "
        "(an admin can allow real names)."
    )

    def _name_patterns(self, ctx: ScanContext) -> list[re.Pattern]:
        if ctx.allow_real_name:
            return []
        tokens = _name_tokens(ctx.full_name)
        if not tokens:
            return []
        joiner = r"[\s._\-]*"
        phrases = []
        if len(tokens) == 1:
            if len(tokens[0]) >= 4:
                phrases.append([tokens[0]])
        else:
            phrases.append(tokens)
            first, last = tokens[0], tokens[-1]
            phrases.extend([[first, last], [last, first]])
            if len(tokens) >= 3:
                phrases.append([tokens[0], tokens[1]])
        seen = set()
        patterns = []
        for phrase in phrases:
            key = tuple(phrase)
            if key in seen:
                continue
            seen.add(key)
            body = joiner.join(re.escape(token) for token in phrase)
            patterns.append(re.compile(rf"(?<![^\W_]){body}(?![^\W_])", re.I))
        return patterns

    def find(self, text, ctx):
        for pattern in self._name_patterns(ctx):
            for match in pattern.finditer(text):
                yield match.start(), match.end()
        email = normalize(ctx.email).casefold()
        if email and "@" in email:
            for match in re.finditer(re.escape(email), text, re.I):
                yield match.start(), match.end()
            local = email.split("@", 1)[0]
            if len(local) >= 5:
                for match in re.finditer(rf"(?<![\w.]){re.escape(local)}(?![\w])", text, re.I):
                    yield match.start(), match.end()
        phone = digits_only(ctx.phone)
        if len(phone) >= 8:
            tail = phone[-10:]
            for match in re.finditer(r"\+?\(?\d[\d\s().\-]{6,22}\d", text):
                if tail in _digits(match.group()):
                    yield match.start(), match.end()


def handle_mentions_identity(handle: str, ctx: ScanContext) -> bool:
    """True when the handle spells out the owner's real name or email name."""
    key = alnum_key(handle)
    if not key:
        return False
    if not ctx.allow_real_name:
        tokens = [token for token in _name_tokens(ctx.full_name) if len(token) >= 3]
        if len(tokens) >= 2:
            first, last = tokens[0], tokens[-1]
            if first + last in key or last + first in key or "".join(tokens) in key:
                return True
        elif len(tokens) == 1 and len(tokens[0]) >= 4 and tokens[0] in key:
            return True
    local = alnum_key(str(ctx.email or "").split("@", 1)[0])
    if len(local) >= 5 and local in key:
        return True
    return False


def iter_codes() -> Iterator[str]:  # pragma: no cover - debugging helper
    from .engine import detectors

    for detector in detectors():
        yield detector.code

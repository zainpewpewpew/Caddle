"""Generator nilai acuan (golden) untuk backend/features/regime.js.

Sumber acuan open source: pustaka Python `ta` (https://github.com/bukosabino/ta, lisensi MIT):
  - ta.trend.ADXIndicator  -> adx(), adx_pos() (+DI), adx_neg() (-DI), Wilder, window 14
  - ta.volatility.BollingerBands -> bollinger_wband() (window 20, dev 2, stdev populasi ddof=0; DIKALI 100)

Deret OHLCV deterministik (~150 candle) dibuat dengan LCG berbenih tetap sehingga hasilnya identik di
setiap mesin. Fase: naik kuat -> sideways bolak-balik -> kompresi -> turun.

Cara pakai (venv terpisah, tidak masuk dependensi proyek):
  python3 -m venv /tmp/venv-rg && /tmp/venv-rg/bin/pip install ta pandas
  /tmp/venv-rg/bin/python scripts/golden/regime_golden.py > tests/fixtures/features/regime-golden.json
"""

import json
import math
from importlib.metadata import version

import pandas as pd
from ta.trend import ADXIndicator
from ta.volatility import BollingerBands

N = 150
ADX_WINDOW = 14
BB_WINDOW = 20
BB_DEV = 2


def lcg(seed):
    state = seed
    while True:
        state = (1103515245 * state + 12345) % 2147483648
        yield state / 2147483648


def make_candles():
    rnd = lcg(20261026)
    candles = []
    close = 100.0
    for i in range(N):
        if i < 40:
            drift, vol = 0.9, 0.6
        elif i < 80:
            drift, vol = (1.2 if i % 2 == 0 else -1.2), 0.8
        elif i < 110:
            drift, vol = 0.0, 0.15
        else:
            drift, vol = -0.8, 0.7
        open_ = close
        close = round(open_ + drift + (next(rnd) - 0.5) * 2 * vol, 6)
        high = round(max(open_, close) + next(rnd) * vol, 6)
        low = round(min(open_, close) - next(rnd) * vol, 6)
        volume = round(1000 + next(rnd) * 500, 3)
        candles.append({"open": open_, "high": high, "low": low, "close": close, "volume": volume})
    return candles


def clean(series):
    out = []
    for v in series:
        out.append(None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 10))
    return out


def main():
    candles = make_candles()
    df = pd.DataFrame(candles)
    adx_ind = ADXIndicator(df["high"], df["low"], df["close"], window=ADX_WINDOW, fillna=False)
    bb = BollingerBands(df["close"], window=BB_WINDOW, window_dev=BB_DEV, fillna=False)
    payload = {
        "source": {
            "library": "ta (bukosabino/ta, MIT)",
            "taVersion": version("ta"),
            "pandasVersion": version("pandas"),
            "numpyVersion": version("numpy"),
            "generator": "scripts/golden/regime_golden.py",
            "notes": [
                "ADX/+DI/-DI: ta.trend.ADXIndicator(window=14). Wilder: seed = jumlah TR/+DM/-DM indeks 1..14, "
                "DI pertama sah di indeks 14, ADX pertama = rata-rata DX indeks 14..27 di indeks 27.",
                "ta mengisi 0 (bukan NaN) untuk seluruh warm-up, dan +DI/-DI di indeks 14 (seed) juga ditulis 0; "
                "pembanding hanya memakai indeks >= firstValid.",
                "wband ta = (upper - lower) / middle * 100 dengan stdev populasi (ddof=0); bagi 100 untuk regime.js.",
            ],
            "firstValid": {"plusDi": ADX_WINDOW + 1, "minusDi": ADX_WINDOW + 1, "adx": 2 * ADX_WINDOW - 1,
                           "wband": BB_WINDOW - 1},
        },
        "params": {"adxWindow": ADX_WINDOW, "bbWindow": BB_WINDOW, "bbDev": BB_DEV},
        "candles": candles,
        "expected": {
            "adx": clean(adx_ind.adx()),
            "plusDi": clean(adx_ind.adx_pos()),
            "minusDi": clean(adx_ind.adx_neg()),
            "wband": clean(bb.bollinger_wband()),
        },
    }
    print(json.dumps(payload, indent=1))


if __name__ == "__main__":
    main()

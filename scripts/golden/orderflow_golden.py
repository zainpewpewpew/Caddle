#!/usr/bin/env python3
"""Generator nilai acuan (golden) OBV, A/D dan CMF dari pustaka open source `ta` (MIT).

Tidak dijalankan CI. Dipakai untuk membuat ulang tests/fixtures/features/orderflow-golden.json:

    python3 -m venv /tmp/venv-of && /tmp/venv-of/bin/pip install ta pandas
    /tmp/venv-of/bin/python scripts/golden/orderflow_golden.py > tests/fixtures/features/orderflow-golden.json

Deret OHLCV deterministik (tanpa acak): kombinasi sinus + LCG berbenih, dibulatkan 4 desimal agar
nilai JSON persis sama di JS. Deret sengaja memuat satu candle H=L (doji datar) untuk menguji MFM=0.
"""
import json
import math
from importlib.metadata import version

import pandas as pd
from ta.volume import AccDistIndexIndicator, ChaikinMoneyFlowIndicator, OnBalanceVolumeIndicator

N = 60
CMF_PERIOD = 20


def series():
    seed = 12345
    rows = []
    prev_close = 100.0
    for i in range(N):
        seed = (seed * 1103515245 + 12345) % 2**31
        r = seed / 2**31  # 0..1
        drift = math.sin(i / 6.0) * 1.2 + (r - 0.5) * 1.5
        close = round(prev_close + drift, 4)
        if i > 0 and close == prev_close:
            close = round(close + 0.0137, 4)  # hindari close sama (konvensi OBV berbeda, lihat catatan)
        open_ = round(prev_close, 4)
        high = round(max(open_, close) + 0.3 + r * 0.7, 4)
        low = round(min(open_, close) - 0.3 - (1 - r) * 0.7, 4)
        if i == 25:  # candle datar H=L=O=C
            open_ = high = low = close
        volume = round(1000 + 800 * abs(math.cos(i / 4.0)) + r * 500, 4)
        taker = round(volume * (0.3 + 0.4 * r), 4)
        rows.append({
            'open': open_, 'high': high, 'low': low, 'close': close,
            'volume': volume, 'takerBuyVolume': taker,
        })
        prev_close = close
    return rows


def main():
    rows = series()
    df = pd.DataFrame(rows)
    obv = OnBalanceVolumeIndicator(close=df['close'], volume=df['volume']).on_balance_volume()
    adi = AccDistIndexIndicator(high=df['high'], low=df['low'], close=df['close'],
                                volume=df['volume']).acc_dist_index()
    cmf = ChaikinMoneyFlowIndicator(high=df['high'], low=df['low'], close=df['close'],
                                    volume=df['volume'], window=CMF_PERIOD).chaikin_money_flow()

    def clean(s):
        return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else float(v) for v in s]

    out = {
        'source': 'Pustaka Python `ta` (Technical Analysis Library, MIT) — ta.volume: '
                  'OnBalanceVolumeIndicator, AccDistIndexIndicator, ChaikinMoneyFlowIndicator',
        'libraries': {'ta': version('ta'), 'pandas': version('pandas'), 'numpy': version('numpy')},
        'generator': 'scripts/golden/orderflow_golden.py',
        'notes': [
            'OBV ta: candle pertama = +volume[0] (perbandingan dengan NaN dianggap naik) dan close sama '
            'dengan sebelumnya dihitung +volume. Konvensi AlphaLens: OBV[0] = 0 dan close sama = 0. '
            'Deret ini tidak memuat close sama, jadi obvAlphaLens[i] = obvTa[i] − volume[0].',
            'A/D (acc_dist_index) dan CMF memakai MFM=0 bila H=L (ta: fillna(0) setelah 0/0); '
            'konvensi identik, dibandingkan langsung.',
            'CMF ta: null (NaN) sampai indeks period−1, sama dengan konvensi AlphaLens.',
        ],
        'cmfPeriod': CMF_PERIOD,
        'candles': rows,
        'expected': {'obv': clean(obv), 'accDist': clean(adi), 'cmf': clean(cmf)},
    }
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()

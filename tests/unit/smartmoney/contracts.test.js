import { describe, expect, it } from 'vitest';
import {
  CHAINS, NATIVE_TOKEN, QUOTE_ASSETS, STABLECOINS, STABLECOIN_SYMBOLS, SYNTHETIC_LOG_INDEX_MIN, WRAPPED_NATIVE,
  isQuoteAsset, isStablecoinAsset, isWrappedNative, normalizeAddress,
} from '../../../backend/smartmoney/contracts.js';

describe('contracts — aset quote & stablecoin', () => {
  it('UNIT-SM-CON-001 aset quote utama per chain tercantum (USDT Optimism, USDC.e, WETH Polygon, USDbC, FDUSD, BUSD, ETH BSC)', () => {
    const expected = [
      ['optimism', '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', 'USDT'],
      ['optimism', '0x7f5c764cbc14f9669b88837ca1490cca17c31607', 'USDC.e'],
      ['arbitrum', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', 'USDC.e'],
      ['polygon', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', 'USDC.e'],
      ['polygon', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', 'WETH'],
      ['base', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', 'USDbC'],
      ['bsc', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', 'FDUSD'],
      ['bsc', '0x2170ed0880ac9a755fd29b2688956bd959f933f8', 'ETH'],
      ['bsc', '0xe9e7cea3dedca5984780bafc599bd69add087d56', 'BUSD'],
      ['arbitrum', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', 'DAI'],
      ['optimism', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', 'DAI'],
      ['polygon', '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', 'DAI'],
      ['base', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', 'DAI'],
    ];
    for (const [chain, address, symbol] of expected) {
      expect(isQuoteAsset(chain, address), `${chain} ${symbol}`).toBe(true);
      expect(QUOTE_ASSETS[chain][address]).toBe(symbol);
    }
    // alamat BUSD yang salah ketik (bukan kontrak BUSD resmi) tidak dicantumkan
    expect(isQuoteAsset('bsc', '0xe9e7cea3dcae0e3d4a5b2c4c2b5b0c3d5d1a6c0b')).toBe(false);
  });

  it('UNIT-SM-CON-002 setiap alamat quote valid & kanonik untuk chain-nya; tiap chain punya native', () => {
    expect(Object.keys(QUOTE_ASSETS).sort()).toEqual([...CHAINS].sort());
    for (const [chain, assets] of Object.entries(QUOTE_ASSETS)) {
      expect(assets[NATIVE_TOKEN]).toBeTruthy();
      for (const address of Object.keys(assets)) expect(normalizeAddress(chain, address), `${chain}:${address}`).toBe(address);
    }
  });

  it('UNIT-SM-CON-003 STABLECOINS = subset QUOTE_ASSETS bersimbol stablecoin; identitas = alamat, bukan simbol', () => {
    for (const [chain, coins] of Object.entries(STABLECOINS)) {
      for (const [address, symbol] of Object.entries(coins)) {
        expect(QUOTE_ASSETS[chain][address]).toBe(symbol);
        expect(STABLECOIN_SYMBOLS).toContain(symbol);
        expect(isStablecoinAsset(chain, address)).toBe(true);
      }
    }
    expect(isStablecoinAsset('arbitrum', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8')).toBe(true);
    expect(isStablecoinAsset('ethereum', NATIVE_TOKEN)).toBe(false);
    expect(isStablecoinAsset('ethereum', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')).toBe(false); // WETH
    expect(isStablecoinAsset('bsc', '0x2170ed0880ac9a755fd29b2688956bd959f933f8')).toBe(false); // ETH (Binance-Peg)
    expect(isStablecoinAsset('ethereum', '0x0000000000000000000000000000000000000001')).toBe(false); // simbol "USDC" palsu
    expect(isStablecoinAsset('dogechain', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(false);
    expect(Object.isFrozen(STABLECOINS) && Object.isFrozen(STABLECOINS.ethereum)).toBe(true);
  });

  it('UNIT-SM-CON-004 WRAPPED_NATIVE hanya WETH/WBNB/WPOL/WSOL (bukan WETH bridged di Polygon); SYNTHETIC_LOG_INDEX_MIN', () => {
    expect(WRAPPED_NATIVE.ethereum).toEqual(['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']);
    expect(WRAPPED_NATIVE.base).toEqual(['0x4200000000000000000000000000000000000006']);
    expect(WRAPPED_NATIVE.bsc).toEqual(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c']);
    expect(WRAPPED_NATIVE.polygon).toEqual(['0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270']);
    expect(WRAPPED_NATIVE.solana).toEqual(['So11111111111111111111111111111111111111112']);
    expect(isWrappedNative('polygon', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619')).toBe(false);
    expect(isWrappedNative('arbitrum', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1')).toBe(true);
    expect(isWrappedNative('ethereum', NATIVE_TOKEN)).toBe(false);
    expect(isWrappedNative('dogechain', '0x0')).toBe(false);
    expect(SYNTHETIC_LOG_INDEX_MIN).toBe(1e15);
  });
});

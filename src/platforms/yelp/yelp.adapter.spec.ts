/**
 * Coverage for the OAuth code-exchange dedup added to YelpAdapter. Same
 * shape as the TT defence — RFC 6749 §4.1.2 says any compliant OAuth
 * provider MUST deny code reuse and SHOULD revoke the previously issued
 * token. We never want to POST the same code twice.
 */

import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { YelpAdapter } from './yelp.adapter';

jest.mock('axios');

function buildConfigMock(): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      const map: Record<string, string> = {
        'yelp.apiKey': 'test-api-key',
        'yelp.clientId': 'test-client-id',
        'yelp.clientSecret': 'test-client-secret',
        'yelp.redirectUri': 'https://example.com/cb',
      };
      return map[key];
    }),
  } as any as ConfigService;
}

function tokenResponse() {
  return {
    data: {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'leads',
    },
  };
}

describe('YelpAdapter — OAuth code-exchange dedup', () => {
  let adapter: YelpAdapter;
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  beforeEach(() => {
    jest.useFakeTimers();
    adapter = new YelpAdapter(buildConfigMock());
    mockedAxios.post.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('single callback POSTs to Yelp /token exactly once', async () => {
    mockedAxios.post.mockResolvedValueOnce(tokenResponse());
    const creds = await adapter.handleCallback('code-A', 'user-1');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(creds.accessToken).toBe('at-1');
  });

  it('duplicate concurrent callbacks for same code POST only once', async () => {
    mockedAxios.post.mockResolvedValueOnce(tokenResponse());
    // Three callbacks fired before the first resolves — mirrors the
    // browser/proxy retry pattern observed on TT (3x within 500ms).
    const [a, b, c] = await Promise.all([
      adapter.handleCallback('code-B', 'user-1'),
      adapter.handleCallback('code-B', 'user-1'),
      adapter.handleCallback('code-B', 'user-1'),
    ]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    // All three callers see the same successful result.
    expect(a.accessToken).toBe('at-1');
    expect(b.accessToken).toBe('at-1');
    expect(c.accessToken).toBe('at-1');
  });

  it('different codes each POST once (cache is per-code)', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { ...tokenResponse().data, access_token: 'at-X' } })
      .mockResolvedValueOnce({ data: { ...tokenResponse().data, access_token: 'at-Y' } });
    const [x, y] = await Promise.all([
      adapter.handleCallback('code-X', 'user-1'),
      adapter.handleCallback('code-Y', 'user-1'),
    ]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(x.accessToken).toBe('at-X');
    expect(y.accessToken).toBe('at-Y');
  });

  it('post-settlement straggler within 60s window hits cache (no re-POST)', async () => {
    mockedAxios.post.mockResolvedValueOnce(tokenResponse());
    const first = await adapter.handleCallback('code-S', 'user-1');
    // Straggler arrives 30s later — proxy retry tail
    jest.advanceTimersByTime(30_000);
    const straggler = await adapter.handleCallback('code-S', 'user-1');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(straggler.accessToken).toBe(first.accessToken);
  });

  it('after 60s TTL elapses, same code triggers a fresh POST', async () => {
    mockedAxios.post.mockResolvedValueOnce(tokenResponse());
    await adapter.handleCallback('code-T', 'user-1');
    // Past TTL — entry deleted, fresh exchange allowed
    jest.advanceTimersByTime(61_000);
    mockedAxios.post.mockResolvedValueOnce({ data: { ...tokenResponse().data, access_token: 'at-T2' } });
    const second = await adapter.handleCallback('code-T', 'user-1');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(second.accessToken).toBe('at-T2');
  });

  it('failed exchange is also cached (stragglers do not re-POST a known-bad code)', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'invalid_grant', error_description: 'expired' } },
      message: 'Request failed with status code 400',
    });
    await expect(adapter.handleCallback('code-F', 'user-1')).rejects.toThrow(/Failed to exchange/);
    // Straggler within window — should NOT hit Yelp again, just re-throw cached error
    await expect(adapter.handleCallback('code-F', 'user-1')).rejects.toThrow(/Failed to exchange/);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

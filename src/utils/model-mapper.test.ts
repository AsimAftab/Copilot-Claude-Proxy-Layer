import { jest } from '@jest/globals';

// The resolver reads the live catalog; stub it so tests are deterministic.
const CATALOG = [
  { id: 'claude-opus-5', vendor: 'Anthropic', capabilities: { type: 'chat' } },
  { id: 'claude-opus-4.8', vendor: 'Anthropic', capabilities: { type: 'chat' } },
  { id: 'claude-sonnet-4.5', vendor: 'Anthropic', capabilities: { type: 'chat' } },
  { id: 'claude-haiku-4.5', vendor: 'Anthropic', capabilities: { type: 'chat' } },
  { id: 'gpt-5.2', vendor: 'Azure OpenAI', capabilities: { type: 'chat' } },
];

const getCopilotModelsMock = jest.fn(async () => CATALOG);
const getExposedModelsMock = jest.fn(async () => CATALOG.filter((m) => m.vendor === 'Anthropic'));
const isLiveCatalogMock = jest.fn(() => true);

jest.unstable_mockModule('../services/models-service.js', () => ({
  getCopilotModels: getCopilotModelsMock,
  getExposedModels: getExposedModelsMock,
  isAnthropicChatModel: (m: { vendor?: string; id: string }) =>
    m.vendor?.toLowerCase() === 'anthropic' || m.id.startsWith('claude'),
  isLiveCatalog: isLiveCatalogMock,
  getModelLimits: jest.fn(async () => undefined),
}));

const { resolveModel, getAvailableModels, getModelDisplayName, __testing } = await import(
  './model-mapper.js'
);

beforeEach(() => {
  getCopilotModelsMock.mockReset();
  getCopilotModelsMock.mockImplementation(async () => CATALOG);
  getExposedModelsMock.mockReset();
  getExposedModelsMock.mockImplementation(async () =>
    CATALOG.filter((m) => m.vendor === 'Anthropic')
  );
});

describe('model resolution', () => {
  it('returns an exact catalog match unchanged', async () => {
    await expect(resolveModel('claude-opus-5')).resolves.toBe('claude-opus-5');
  });

  // Copilot uses dots, Claude Code sends hyphens - this is the core ambiguity.
  it('folds hyphens to the catalog dot form', async () => {
    await expect(resolveModel('claude-sonnet-4-5')).resolves.toBe('claude-sonnet-4.5');
  });

  it('strips Anthropic date suffixes', async () => {
    await expect(resolveModel('claude-sonnet-4-5-20250514')).resolves.toBe(
      'claude-sonnet-4.5'
    );
  });

  it('resolves a bare family alias to the newest model', async () => {
    await expect(resolveModel('opus')).resolves.toBe('claude-opus-5');
    await expect(resolveModel('haiku')).resolves.toBe('claude-haiku-4.5');
  });

  it('resolves an unknown claude version to the newest in family', async () => {
    await expect(resolveModel('claude-opus-9-9')).resolves.toBe('claude-opus-5');
  });

  it('passes non-Claude models through untouched', async () => {
    await expect(resolveModel('gpt-5.2')).resolves.toBe('gpt-5.2');
  });

  // Previously returned a hardcoded ID that was absent from the live catalog,
  // producing a confusing upstream 404 for a model the user never asked for.
  it('does not invent a model the live catalog lacks', async () => {
    getCopilotModelsMock.mockImplementation(async () => [
      { id: 'claude-sonnet-4.5', vendor: 'Anthropic', capabilities: { type: 'chat' } },
      { id: 'claude-opus-4.8', vendor: 'Anthropic', capabilities: { type: 'chat' } },
    ]);

    // No Haiku in this catalog - must fall back to the default, not guess.
    const resolved = await resolveModel('claude-3-5-haiku-20241022');
    expect(resolved).not.toBe('claude-haiku-4.5');
    expect(['claude-opus-5', 'claude-sonnet-4.5', 'claude-opus-4.8']).toContain(resolved);
  });

  it('falls back to the configured default for an empty model', async () => {
    await expect(resolveModel('')).resolves.toBe('claude-opus-5');
  });

  it('uses the static fallback catalog when catalog lookup rejects', async () => {
    getCopilotModelsMock.mockRejectedValueOnce(new Error('offline'));

    await expect(resolveModel('claude-sonnet-4-5-20250514')).resolves.toBe(
      'claude-sonnet-4.5'
    );
  });
});

describe('getAvailableModels', () => {
  it('exposes discovered Anthropic models in Anthropic list format', async () => {
    const list = await getAvailableModels();

    expect(list.object).toBe('list');
    expect(list.data.map((m) => m.id)).toContain('claude-opus-5');
    expect(list.data.every((m) => m.object === 'model')).toBe(true);
  });
});

describe('helpers', () => {
  it('normalizes separators and suffixes', () => {
    expect(__testing.normalize('Claude-Opus-4.5-20250514')).toBe('claude-opus-4-5');
  });

  it('scores newer versions higher', () => {
    expect(__testing.versionScore('claude-opus-5')).toBeGreaterThan(
      __testing.versionScore('claude-opus-4.8')
    );
  });

  it('produces readable display names', () => {
    expect(getModelDisplayName('claude-opus-5')).toBe('Claude Opus 5');
  });
});

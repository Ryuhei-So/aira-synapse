import type { ProviderHealth } from '../../domain/provider/index.js';

export interface RuntimePolicyConfig {
  readonly localOnly: boolean;
  readonly providers: {
    readonly llm: { readonly backend: string };
    readonly embedding: { readonly backend: string };
    readonly nlp: { readonly backend: 'python-sidecar' | 'llm' | 'regex' };
  };
}

export interface CapabilityHealthResults {
  readonly pythonSidecar?: ProviderHealth;
  readonly llm?: ProviderHealth;
  readonly openaiEmbedding?: ProviderHealth;
  readonly localEmbedding?: ProviderHealth;
}

export interface RuntimeCapabilities {
  readonly localOnly: boolean;
  readonly selectedNlpExtractor: 'python-sidecar' | 'llm' | 'regex';
  readonly selectedEmbeddingProvider: 'openai' | 'local' | 'none';
  readonly apiFeaturesEnabled: boolean;
  readonly llmGenerationEnabled: boolean;
  readonly vectorRetrievalEnabled: boolean;
  readonly lexicalRetrievalEnabled: boolean;
  readonly templateResponseEnabled: boolean;
  readonly symbolicFallbacksEnabled: boolean;
}

export interface FeatureGates {
  readonly buildDictionaryFromApi: boolean;
  readonly llmQueryGeneration: boolean;
  readonly vectorRetrieval: boolean;
  readonly lexicalRetrieval: boolean;
  readonly templateResponse: boolean;
  readonly symbolicCanonicalization: boolean;
}

function isHealthy(result?: ProviderHealth): boolean {
  return result?.healthy === true;
}

export class DegradedModePolicy {
  public evaluateCapabilities(
    config: RuntimePolicyConfig,
    healthResults: CapabilityHealthResults = {},
  ): RuntimeCapabilities {
    const selectedNlpExtractor = this.selectNlpExtractor(config, healthResults);
    const selectedEmbeddingProvider = this.selectEmbeddingProvider(config, healthResults);

    return {
      localOnly: config.localOnly,
      selectedNlpExtractor,
      selectedEmbeddingProvider,
      apiFeaturesEnabled: !config.localOnly,
      llmGenerationEnabled: !config.localOnly && config.providers.llm.backend !== 'none',
      vectorRetrievalEnabled: selectedEmbeddingProvider !== 'none',
      lexicalRetrievalEnabled: true,
      templateResponseEnabled: true,
      symbolicFallbacksEnabled: true,
    };
  }

  public selectNlpExtractor(
    config: RuntimePolicyConfig,
    healthResults: CapabilityHealthResults = {},
  ): 'python-sidecar' | 'llm' | 'regex' {
    if (config.providers.nlp.backend === 'python-sidecar' && isHealthy(healthResults.pythonSidecar)) {
      return 'python-sidecar';
    }
    if (!config.localOnly && isHealthy(healthResults.llm)) {
      return 'llm';
    }
    return 'regex';
  }

  public selectEmbeddingProvider(
    config: RuntimePolicyConfig,
    healthResults: CapabilityHealthResults = {},
  ): 'openai' | 'local' | 'none' {
    if (!config.localOnly && config.providers.embedding.backend === 'openai' && isHealthy(healthResults.openaiEmbedding)) {
      return 'openai';
    }
    if (config.providers.embedding.backend === 'local' || isHealthy(healthResults.localEmbedding)) {
      return 'local';
    }
    return 'none';
  }

  public getFeatureGates(capabilities: RuntimeCapabilities): FeatureGates {
    return {
      buildDictionaryFromApi: capabilities.apiFeaturesEnabled,
      llmQueryGeneration: capabilities.llmGenerationEnabled,
      vectorRetrieval: capabilities.vectorRetrievalEnabled,
      lexicalRetrieval: capabilities.lexicalRetrievalEnabled,
      templateResponse: capabilities.templateResponseEnabled,
      symbolicCanonicalization: capabilities.symbolicFallbacksEnabled,
    };
  }
}

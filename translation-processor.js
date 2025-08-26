import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enhanced system prompt with better context handling
const getSystemPrompt = (languageName) => `You are an expert linguist specializing in ${languageName} to English translation.
You will be given a batch of words from a transcription along with contextual information from surrounding text.

Your task is to translate the words into natural, fluent English while preserving temporal alignment and meaning.

Core Rules:
1. **Contextual Translation**: Use the provided context (previous/next segments) to understand the full meaning and maintain narrative flow.
2. **Natural English**: Create fluent, grammatically correct English. Rephrase and reorder as needed (e.g., SOV → SVO).
3. **Flexible Word Alignment**: Aim to match word count, but prioritize natural translation. If exact matching creates awkward phrasing, use natural word boundaries.
4. **Timestamp Preservation**: Distribute timestamps across translated words to maintain temporal alignment with the original audio.
5. **Sentence Continuity**: Ensure translations connect smoothly with context, avoiding abrupt breaks or repetition.

Context Usage Guidelines:
- Use previous_context to understand ongoing topics and maintain pronoun references
- Use next_context to anticipate direction and avoid incomplete thoughts
- If a word/phrase is unclear, infer meaning from surrounding context
- Maintain consistent terminology and style throughout

Output Format:
Return a valid JSON object with:
- "translated_text": Natural English translation of the batch
- "translated_words": Array of objects with {word, start_time, end_time}
- "context_notes": Brief explanation of key contextual decisions made

Example output:
{
  "translated_text": "These are the words we need to translate properly",
  "translated_words": [
    {"word": "These", "start_time": 0.359, "end_time": 0.459},
    {"word": "are", "start_time": 0.479, "end_time": 0.639}
  ],
  "context_notes": "Maintained formal tone from previous context"
}`;

class EnhancedTranslationProcessor {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 200; // Smaller batches for better context
    this.contextOverlap = options.contextOverlap || 50; // Words of overlap for context
    this.outputDir = options.outputDir || __dirname;
    this.apiProvider = options.apiProvider || 'openai';
    this.maxConcurrentBatches = options.maxConcurrentBatches || 3; // Reduced for stability
    this.languageName = options.languageName || 'Urdu';
    this.openaiApiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
    this.maxRetries = options.maxRetries || 2;
    this.retryDelay = options.retryDelay || 1000;
  }

  validateInput(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid JSON: Expected an object');
    }
    if (!data.text || typeof data.text !== 'string') {
      throw new Error('Invalid JSON: Missing or invalid "text" string');
    }
    if (!Array.isArray(data.words)) {
      throw new Error('Invalid JSON: Missing or invalid "words" array');
    }
    
    // Validate word structure
    for (let i = 0; i < Math.min(10, data.words.length); i++) {
      const word = data.words[i];
      if (!word.text || typeof word.start !== 'number') {
        throw new Error(`Invalid word structure at index ${i}. Expected {text, start, end?}`);
      }
    }
    
    console.log(`📊 Found ${data.words.length} words to process.`);
    console.log(`📝 Full text context is ${data.text.length} characters long.`);
    return true;
  }

  createEnhancedBatches(words, batchSize, contextOverlap) {
    const batches = [];
    let currentIndex = 0;
    
    while (currentIndex < words.length) {
      const batchStart = currentIndex;
      const batchEnd = Math.min(currentIndex + batchSize, words.length);
      
      // Calculate context boundaries
      const contextStart = Math.max(0, batchStart - contextOverlap);
      const contextEnd = Math.min(words.length, batchEnd + contextOverlap);
      
      const batch = {
        id: batches.length + 1,
        startIndex: batchStart,
        endIndex: batchEnd,
        words: words.slice(batchStart, batchEnd),
        previousContext: batchStart > 0 ? words.slice(contextStart, batchStart) : [],
        nextContext: batchEnd < words.length ? words.slice(batchEnd, contextEnd) : [],
        timeRange: this.getTimeRange(words.slice(batchStart, batchEnd))
      };
      
      batches.push(batch);
      currentIndex = batchEnd;
    }
    
    return batches;
  }

  getTimeRange(words) {
    if (words.length === 0) return { start: 0, end: 0 };
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    return {
      start: firstWord.start || 0,
      end: lastWord.end || lastWord.start || 0,
    };
  }

  createContextualPrompt(batch, languageName) {
    const systemPrompt = getSystemPrompt(languageName);
    
    // Create context strings
    const previousContextText = batch.previousContext
      .map(w => w.text).join(' ');
    const nextContextText = batch.nextContext
      .map(w => w.text).join(' ');
    const currentBatchText = batch.words
      .map(w => w.text).join(' ');
    
    const userPrompt = `Translate the MAIN BATCH into natural English using the provided context.

PREVIOUS CONTEXT (for reference only):
"${previousContextText}"

MAIN BATCH TO TRANSLATE (${batch.words.length} words):
${JSON.stringify(batch.words.map(w => ({
      text: w.text,
      start: w.start,
      end: w.end || w.start
    })), null, 2)}

NEXT CONTEXT (for reference only):
"${nextContextText}"

Instructions:
1. Translate only the MAIN BATCH words
2. Use context to understand meaning and maintain flow
3. Create natural English that would connect smoothly with surrounding context
4. Preserve temporal information by distributing timestamps appropriately
5. If word count needs adjustment for natural English, prioritize fluency over exact count matching`;

    return { systemPrompt, userPrompt };
  }

  async translateBatchWithRetry(batch, attempt = 1) {
    try {
      return await this.translateBatch(batch);
    } catch (error) {
      console.error(`❌ Batch ${batch.id} attempt ${attempt} failed:`, error.message);
      
      if (attempt < this.maxRetries) {
        console.log(`🔄 Retrying batch ${batch.id} (attempt ${attempt + 1}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
        return this.translateBatchWithRetry(batch, attempt + 1);
      }
      
      // Final fallback - create a reasonable translation
      return this.createFallbackTranslation(batch, error.message);
    }
  }

  createFallbackTranslation(batch, errorMessage) {
    console.warn(`⚠️ Creating fallback translation for batch ${batch.id}`);
    
    // Simple fallback: transliterate or use original with [UNTRANSLATED] marker
    const fallbackWords = batch.words.map(word => ({
      word: `[?]${word.text}`,
      start_time: word.start,
      end_time: word.end || word.start
    }));
    
    return {
      batchId: batch.id,
      status: 'fallback',
      translatedText: fallbackWords.map(w => w.word).join(' '),
      translatedWords: fallbackWords,
      originalWords: batch.words,
      translatedAt: new Date().toISOString(),
      tokensUsed: 0,
      error: errorMessage,
      contextNotes: 'Fallback translation due to processing error'
    };
  }

  async translateBatch(batch) {
    if (this.apiProvider === 'openai') {
      return this.translateBatchWithOpenAI(batch);
    }
    
    // Demo mode with improved mock translation
    console.log(`🔄 [DEMO] Translating batch ${batch.id} (${batch.words.length} words)`);
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
    
    const mockTranslatedWords = batch.words.map(word => ({
      word: `[EN]${word.text}`,
      start_time: word.start || 0,
      end_time: word.end || word.start || 0,
    }));
    
    return {
      batchId: batch.id,
      status: 'completed',
      translatedText: mockTranslatedWords.map(w => w.word).join(' '),
      translatedWords: mockTranslatedWords,
      originalWords: batch.words,
      translatedAt: new Date().toISOString(),
      tokensUsed: 0,
      contextNotes: 'Demo translation with context awareness'
    };
  }

  async translateBatchWithOpenAI(batch) {
    if (!this.openaiApiKey) {
      throw new Error('OpenAI API key not provided');
    }
    
    let OpenAI;
    try {
      const openaiModule = await import('openai');
      OpenAI = openaiModule.default;
    } catch (error) {
      throw new Error('OpenAI package not found. Please run: npm install openai');
    }
    
    const openai = new OpenAI({ apiKey: this.openaiApiKey });

    console.log(`🤖 Translating batch ${batch.id} with enhanced context...`);
    
    const { systemPrompt, userPrompt } = this.createContextualPrompt(batch, this.languageName);
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2, // Slightly higher for more natural translations
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('OpenAI returned an empty response');
    }

    let translationResult;
    try {
      translationResult = JSON.parse(content);
    } catch (parseError) {
      throw new Error(`Invalid JSON response from OpenAI: ${parseError.message}`);
    }

    // Validate response structure
    if (!translationResult.translated_text || !translationResult.translated_words) {
      throw new Error('Invalid response format: missing required fields');
    }

    if (!Array.isArray(translationResult.translated_words)) {
      throw new Error('translated_words must be an array');
    }

    // Validate and normalize translated words
    const translatedWords = translationResult.translated_words.map((word, index) => {
      if (!word.word || typeof word.start_time !== 'number' || typeof word.end_time !== 'number') {
        // Use original timing if translation timing is invalid
        const originalWord = batch.words[Math.min(index, batch.words.length - 1)];
        return {
          word: word.word || `[MISSING]`,
          start_time: originalWord.start,
          end_time: originalWord.end || originalWord.start
        };
      }
      return {
        word: word.word,
        start_time: word.start_time,
        end_time: word.end_time
      };
    });

    return {
      batchId: batch.id,
      status: 'completed',
      translatedText: translationResult.translated_text,
      translatedWords,
      originalWords: batch.words,
      translatedAt: new Date().toISOString(),
      tokensUsed: response.usage?.total_tokens || 0,
      contextNotes: translationResult.context_notes || 'No context notes provided'
    };
  }

  async translateAllBatches(batches) {
    console.log(`🚀 Starting enhanced translation of ${batches.length} batches.`);
    console.log(`⚡ Max concurrent batches: ${this.maxConcurrentBatches}`);
    console.log(`🔄 Context overlap: ${this.contextOverlap} words`);
    
    const queue = [...batches];
    const results = [];
    
    const runWorker = async () => {
      while (queue.length > 0) {
        const batch = queue.shift();
        if (!batch) continue;
        
        try {
          const result = await this.translateBatchWithRetry(batch);
          results.push(result);
          
          const progress = ((batches.length - queue.length) / batches.length * 100).toFixed(1);
          console.log(`✅ Batch ${batch.id} completed (${progress}% done)`);
          
        } catch (error) {
          console.error(`❌ Final failure for batch ${batch.id}:`, error.message);
          results.push(this.createFallbackTranslation(batch, error.message));
        }
      }
    };

    const workers = Array(this.maxConcurrentBatches).fill(null).map(runWorker);
    await Promise.all(workers);
    
    return results.sort((a, b) => a.batchId - b.batchId);
  }

  mergeTranslatedBatches(originalData, translatedBatches) {
    console.log('🔄 Merging translated batches with enhanced processing...');
    
    let fullTranslatedText = '';
    const allTranslatedWords = [];
    let totalTokens = 0;
    let successfulBatches = 0;
    let fallbackBatches = 0;
    const failedBatches = [];

    translatedBatches.forEach(batch => {
      if (batch.status === 'completed' || batch.status === 'fallback') {
        // Add space between batches if needed
        if (fullTranslatedText && !fullTranslatedText.endsWith(' ') && 
            batch.translatedText && !batch.translatedText.startsWith(' ')) {
          fullTranslatedText += ' ';
        }
        fullTranslatedText += batch.translatedText;
        
        // Add translated words
        batch.translatedWords.forEach(word => {
          allTranslatedWords.push({
            word: word.word,
            start_time: word.start_time,
            end_time: word.end_time
          });
        });
        
        totalTokens += batch.tokensUsed || 0;
        
        if (batch.status === 'completed') {
          successfulBatches++;
        } else {
          fallbackBatches++;
        }
      } else {
        failedBatches.push(batch);
      }
    });

    // Clean up the final text
    fullTranslatedText = fullTranslatedText.replace(/\s+/g, ' ').trim();

    if (failedBatches.length > 0) {
      console.warn(`⚠️ ${failedBatches.length} batches completely failed.`);
    }
    if (fallbackBatches > 0) {
      console.warn(`⚠️ ${fallbackBatches} batches used fallback translation.`);
    }

    console.log(`📊 Translation completed: ${successfulBatches} successful, ${fallbackBatches} fallback, ${failedBatches.length} failed`);

    return {
      original_metadata: {
        ...originalData,
        processing_timestamp: new Date().toISOString()
      },
      translated_text: fullTranslatedText,
      translated_words: allTranslatedWords,
      translation_metadata: {
        translated_at: new Date().toISOString(),
        source_language: this.languageName,
        target_language: 'English',
        total_batches: translatedBatches.length,
        successful_batches: successfulBatches,
        fallback_batches: fallbackBatches,
        failed_batches: failedBatches.length,
        batch_size: this.batchSize,
        context_overlap: this.contextOverlap,
        total_words_original: originalData.words.length,
        total_words_translated: allTranslatedWords.length,
        total_tokens_used: totalTokens,
        api_provider: this.apiProvider,
        word_count_ratio: allTranslatedWords.length / originalData.words.length
      }
    };
  }

  async processFile(inputPath, outputFileName = 'enhanced_translated.json') {
    try {
      console.log(`📖 Reading file: ${inputPath}`);
      const rawData = await fs.readFile(inputPath, 'utf8');
      const data = JSON.parse(rawData);
      
      this.validateInput(data);
      
      console.log(`✂️ Creating enhanced batches (size: ${this.batchSize}, overlap: ${this.contextOverlap})`);
      const batches = this.createEnhancedBatches(data.words, this.batchSize, this.contextOverlap);
      
      console.log(`📝 Generated ${batches.length} batches with contextual information`);
      
      // Save batch information for debugging
      const batchesPath = path.join(this.outputDir, 'enhanced-batches-debug.json');
      await fs.writeFile(batchesPath, JSON.stringify(batches.map(b => ({
        id: b.id,
        wordCount: b.words.length,
        timeRange: b.timeRange,
        hasContext: {
          previous: b.previousContext.length > 0,
          next: b.nextContext.length > 0
        }
      })), null, 2), 'utf8');
      console.log(`💾 Saved batch debug info to: ${batchesPath}`);
      
      const translatedBatches = await this.translateAllBatches(batches);
      const finalTranslation = this.mergeTranslatedBatches(data, translatedBatches);
      
      const outputPath = path.join(this.outputDir, outputFileName);
      await fs.writeFile(outputPath, JSON.stringify(finalTranslation, null, 2), 'utf8');
      
      console.log(`\n✅ Enhanced translation complete! Saved to: ${outputPath}`);
      this.printEnhancedSummary(finalTranslation);
      
      return finalTranslation;
    } catch (error) {
      console.error('❌ Fatal error during processing:', error.message);
      throw error;
    }
  }

  printEnhancedSummary(translatedData) {
    const { translation_metadata: meta } = translatedData;
    console.log('\n📋 Enhanced Translation Summary:');
    console.log(`   - Source Language: ${meta.source_language}`);
    console.log(`   - Original Words: ${meta.total_words_original}`);
    console.log(`   - Translated Words: ${meta.total_words_translated}`);
    console.log(`   - Word Count Ratio: ${(meta.word_count_ratio * 100).toFixed(1)}%`);
    console.log(`   - Batches: ${meta.successful_batches} successful / ${meta.total_batches} total`);
    console.log(`   - Context Overlap: ${meta.context_overlap} words`);
    console.log(`   - API Provider: ${meta.api_provider}`);
    
    if (meta.total_tokens_used > 0) {
      console.log(`   - Tokens Used: ${meta.total_tokens_used.toLocaleString()}`);
    }
    if (meta.fallback_batches > 0) {
      console.log(`   - ⚠️ Fallback Batches: ${meta.fallback_batches}`);
    }
    if (meta.failed_batches > 0) {
      console.log(`   - ❌ Failed Batches: ${meta.failed_batches}`);
    }
  }
}

// Enhanced CSV to JSON conversion with better validation
async function enhancedCsvToJson(csvInput, isFile = true) {
  try {
    let csvContent = isFile ? await fs.readFile(csvInput, 'utf8') : csvInput;
    
    // Clean and parse CSV
    const lines = csvContent.trim().split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    if (lines.length === 0) {
      throw new Error('CSV file is empty');
    }
    
    const words = [];
    const errors = [];
    
    lines.forEach((line, index) => {
      try {
        // Handle quoted CSV fields
        const parts = line.match(/(?:^|,)("(?:[^"]+|"")*"|[^,]*)/g)
          ?.map(part => part.replace(/^,/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || [];
        
        if (parts.length < 3) {
          errors.push(`Line ${index + 1}: Expected at least 3 columns, got ${parts.length}`);
          return;
        }
        
        const [start_time, end_time, text] = parts;
        
        const startNum = parseFloat(start_time);
        const endNum = parseFloat(end_time);
        
        if (isNaN(startNum) || isNaN(endNum)) {
          errors.push(`Line ${index + 1}: Invalid timestamp values`);
          return;
        }
        
        if (!text || text.length === 0) {
          errors.push(`Line ${index + 1}: Empty text field`);
          return;
        }
        
        words.push({
          start: startNum,
          end: endNum,
          text: text
        });
      } catch (error) {
        errors.push(`Line ${index + 1}: ${error.message}`);
      }
    });
    
    if (errors.length > 0) {
      console.warn(`⚠️ CSV parsing warnings:\n${errors.slice(0, 10).join('\n')}`);
      if (errors.length > 10) {
        console.warn(`   ... and ${errors.length - 10} more errors`);
      }
    }
    
    if (words.length === 0) {
      throw new Error('No valid words found in CSV');
    }
    
    // Sort by timestamp to ensure proper order
    words.sort((a, b) => a.start - b.start);
    
    const text = words.map(word => word.text).join(' ');
    
    console.log(`✅ Parsed ${words.length} words from CSV (${errors.length} errors ignored)`);
    
    return { text, words };
  } catch (error) {
    console.error('❌ Error converting CSV to JSON:', error.message);
    throw error;
  }
}

// Enhanced CSV processing
async function processEnhancedCsvWithTranslation(csvInput, processorOptions, outputFileName = 'enhanced_translated.json') {
  try {
    const jsonData = await enhancedCsvToJson(csvInput);
    console.log('✅ Converted CSV to enhanced JSON structure.');
    
    const processor = new EnhancedTranslationProcessor(processorOptions);
    const tempJsonPath = path.join(processor.outputDir, 'temp_enhanced_input.json');
    
    await fs.writeFile(tempJsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
    console.log(`💾 Saved temporary JSON to: ${tempJsonPath}`);
    
    const result = await processor.processFile(tempJsonPath, outputFileName);
    
    // Clean up temp file
    await fs.unlink(tempJsonPath).catch(err => 
      console.warn('⚠️ Failed to delete temp file:', err.message)
    );
    
    return result;
  } catch (error) {
    console.error('❌ Error processing CSV with enhanced translation:', error.message);
    throw error;
  }
}

// Enhanced CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
🌐 Enhanced Translation Processor with Contextual Intelligence
   Translates JSON or CSV transcription files with improved context awareness and error handling.

Usage:
  node enhanced-translator.js <input-file> [options...]

Options:
  --input-type <json|csv>    Input file type (default: json)
  --batch-size <num>         Words per batch (default: 200)
  --context-overlap <num>    Context overlap in words (default: 50)
  --output <file>            Output filename (default: enhanced_translated.json)
  --concurrent <num>         Max concurrent batches (default: 3)
  --language <name>          Source language name (e.g., "Urdu", "Spanish")
  --api-key <key>           OpenAI API key (or use OPENAI_API_KEY env var)
  --max-retries <num>       Max retries per batch (default: 2)
  --retry-delay <ms>        Delay between retries in ms (default: 1000)

Examples:
  node enhanced-translator.js input.csv --input-type csv --language "Urdu"
  node enhanced-translator.js input.json --batch-size 150 --context-overlap 75
  node enhanced-translator.js input.csv --language "Spanish" --concurrent 2 --max-retries 3
    `);
    return;
  }

  const inputFile = args[0];
  const options = { outputDir: __dirname };
  let inputType = 'json';
  
  // Parse command line arguments
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    
    if (!value || value.startsWith('--')) { 
      i--; 
      continue; 
    }
    
    switch (flag) {
      case '--input-type':
        inputType = value.toLowerCase();
        break;
      case '--batch-size':
        options.batchSize = parseInt(value, 10);
        break;
      case '--context-overlap':
        options.contextOverlap = parseInt(value, 10);
        break;
      case '--output':
        options.outputFile = value;
        break;
      case '--concurrent':
        options.maxConcurrentBatches = parseInt(value, 10);
        break;
      case '--language':
        options.languageName = value;
        break;
      case '--api-key':
        options.openaiApiKey = value;
        break;
      case '--max-retries':
        options.maxRetries = parseInt(value, 10);
        break;
      case '--retry-delay':
        options.retryDelay = parseInt(value, 10);
        break;
    }
  }

  try {
    console.log(`🚀 Starting enhanced translation from ${options.languageName || 'source language'} to English...`);
    console.log(`📊 Configuration: batch=${options.batchSize || 200}, overlap=${options.contextOverlap || 50}, concurrent=${options.maxConcurrentBatches || 3}`);
    
    if (inputType === 'csv') {
      await processEnhancedCsvWithTranslation(inputFile, {
        ...options,
        apiProvider: 'openai'
      }, options.outputFile);
    } else if (inputType === 'json') {
      const processor = new EnhancedTranslationProcessor({
        ...options,
        apiProvider: 'openai'
      });
      await processor.processFile(inputFile, options.outputFile);
    } else {
      throw new Error('Invalid --input-type. Must be "json" or "csv".');
    }
    
    console.log('\n🎉 Enhanced translation completed successfully!');
    
  } catch (error) {
    console.error(`\n❌ Enhanced processing failed: ${error.message}`);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Check if this file is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { 
  EnhancedTranslationProcessor, 
  enhancedCsvToJson, 
  processEnhancedCsvWithTranslation 
};
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enhanced system prompt that outputs CSV for better parsing control
const getSystemPrompt = (languageName) => `You are an expert linguist specializing in ${languageName} to English translation.
You will be given a batch of words from a transcription along with contextual information from surrounding text.

Your task is to translate the words into natural, fluent English while preserving temporal alignment and meaning.

Core Rules:
1. **Complete Translation**: EVERY word must be translated to English. Never leave original ${languageName} words untranslated.
2. **Contextual Understanding**: Use the provided context to understand full meaning and maintain narrative flow.
3. **Natural English**: Create fluent, grammatically correct English. Rephrase and reorder as needed (e.g., SOV → SVO).
4. **Smart Word Distribution**: You may combine multiple ${languageName} words into fewer English words, or split one ${languageName} word into multiple English words as needed for natural translation.
5. **Timestamp Preservation**: Distribute the original timestamps intelligently across your English translation.

Context Usage Guidelines:
- Use previous_context to understand ongoing topics and maintain pronoun references
- Use next_context to anticipate direction and avoid incomplete thoughts
- If a word/phrase is unclear, infer the most likely meaning from surrounding context
- Maintain consistent terminology and style throughout

CRITICAL: Output ONLY a CSV format with exactly 3 columns: start_time,end_time,word
- No headers, no quotes around simple words
- Each line: timestamp,timestamp,english_word
- Timestamps should be decimal numbers
- Words should be clean English words (no special characters unless punctuation)
- The number of output lines should create a natural English translation

Example output for input with 3 words:
0.359,0.559,This
0.559,0.759,is
0.759,0.959,good

Example output for input with 2 words that become 3 English words:
0.100,0.300,I
0.300,0.500,am
0.500,0.700,going`;

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
    
    // Create a basic English translation using common word mappings
    const fallbackWords = batch.words.map(word => {
      const englishWord = this.getBasicTranslation(word.text, this.languageName);
      return {
        word: englishWord,
        start_time: word.start,
        end_time: word.end || word.start
      };
    });
    
    return {
      batchId: batch.id,
      status: 'fallback',
      translatedText: fallbackWords.map(w => w.word).join(' '),
      translatedWords: fallbackWords,
      originalWords: batch.words,
      translatedAt: new Date().toISOString(),
      tokensUsed: 0,
      error: errorMessage,
      contextNotes: 'Fallback translation using basic word mapping'
    };
  }

  getBasicTranslation(word, languageName) {
    // Basic word mappings for common words - expand this as needed
    const commonTranslations = {
      // Urdu common words
      'یہ': 'this',
      'ہے': 'is',
      'اور': 'and',
      'کا': 'of',
      'کے': 'of',
      'کو': 'to',
      'میں': 'in',
      'سے': 'from',
      'پر': 'on',
      'ہو': 'be',
      'نہیں': 'not',
      'کہ': 'that',
      'جو': 'who',
      'اس': 'this',
      'کر': 'do',
      'کے لیے': 'for',
      'ایک': 'a',
      'گیا': 'went',
      'ہوا': 'happened',
      'کیا': 'what',
      'تھا': 'was',
      'ہیں': 'are',
      'تھے': 'were',
      'گے': 'will',
      'رہا': 'staying',
      'رہے': 'staying',
      'رہی': 'staying',
      'والا': 'one',
      'والے': 'ones',
      'والی': 'one',
      'لیے': 'for',
      'ساتھ': 'with',
      'بھی': 'also',
      'ابھی': 'now',
      'یہاں': 'here',
      'وہاں': 'there',
      'کیوں': 'why',
      'کیسے': 'how',
      'کب': 'when',
      'کہاں': 'where',
      
      // Spanish common words
      'el': 'the',
      'la': 'the',
      'de': 'of',
      'que': 'that',
      'y': 'and',
      'a': 'to',
      'en': 'in',
      'un': 'a',
      'ser': 'be',
      'se': 'self',
      'no': 'no',
      'te': 'you',
      'lo': 'it',
      'le': 'him',
      'da': 'gives',
      'su': 'his',
      'por': 'by',
      'son': 'are',
      'con': 'with',
      'para': 'for',
      'al': 'to the',
      'del': 'of the',
      'los': 'the',
      'las': 'the',
      'un': 'a',
      'una': 'a',
      'este': 'this',
      'esta': 'this',
      'como': 'how',
      'pero': 'but',
      'sus': 'their',
      'me': 'me',
      'ya': 'already',
      'muy': 'very',
      'aquí': 'here',
      'hay': 'there is'
    };

    // Check if we have a direct translation
    if (commonTranslations[word.toLowerCase()]) {
      return commonTranslations[word.toLowerCase()];
    }

    // For unknown words, try to create a reasonable English equivalent
    // Remove common diacritics and special characters
    let englishWord = word
      .replace(/[۔؟!]/g, '') // Remove Urdu punctuation
      .replace(/[¿¡]/g, '') // Remove Spanish punctuation
      .replace(/[^\w\s]/g, '') // Remove other special chars
      .trim();

    // If still no match, create a phonetic approximation or generic word
    if (englishWord === word) {
      // Very basic phonetic mapping for common patterns
      englishWord = word
        .replace(/ی/g, 'i')
        .replace(/ا/g, 'a')
        .replace(/و/g, 'o')
        .replace(/ے/g, 'e')
        .replace(/ر/g, 'r')
        .replace(/ت/g, 't')
        .replace(/ن/g, 'n')
        .replace(/م/g, 'm')
        .replace(/ل/g, 'l')
        .replace(/س/g, 's')
        .replace(/د/g, 'd')
        .replace(/ک/g, 'k')
        .replace(/ب/g, 'b')
        .replace(/ف/g, 'f')
        .replace(/ج/g, 'j')
        .replace(/ح/g, 'h')
        .replace(/خ/g, 'kh')
        .replace(/ذ/g, 'z')
        .replace(/ز/g, 'z')
        .replace(/ش/g, 'sh')
        .replace(/غ/g, 'gh')
        .replace(/ق/g, 'q')
        .replace(/ہ/g, 'h')
        .replace(/چ/g, 'ch')
        .replace(/ط/g, 't')
        .replace(/ظ/g, 'z')
        .replace(/ع/g, '')
        .replace(/پ/g, 'p')
        .replace(/ٹ/g, 't')
        .replace(/ڈ/g, 'd')
        .replace(/ڑ/g, 'r')
        .replace(/ں/g, 'n')
        .replace(/ئ/g, 'y')
        .replace(/ء/g, '');

      // Clean up the result
      englishWord = englishWord.replace(/\s+/g, '').toLowerCase();
      
      // If result is empty or too short, use a generic word
      if (!englishWord || englishWord.length < 2) {
        englishWord = 'word';
      }
    }

    return englishWord || 'word';
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

    console.log(`🤖 Translating batch ${batch.id} with CSV output format...`);
    
    const { systemPrompt, userPrompt } = this.createContextualPrompt(batch, this.languageName);
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 2000
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('OpenAI returned an empty response');
    }

    // Parse CSV response
    const translatedWords = this.parseCSVResponse(content.trim(), batch);
    
    if (translatedWords.length === 0) {
      throw new Error('No valid translations found in CSV response');
    }

    const translatedText = translatedWords.map(w => w.word).join(' ');

    return {
      batchId: batch.id,
      status: 'completed',
      translatedText,
      translatedWords,
      originalWords: batch.words,
      translatedAt: new Date().toISOString(),
      tokensUsed: response.usage?.total_tokens || 0,
      contextNotes: `CSV parsing successful: ${translatedWords.length} words extracted`
    };
  }

  parseCSVResponse(csvContent, batch) {
    const lines = csvContent.split('\n').filter(line => line.trim().length > 0);
    const translatedWords = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip empty lines or lines that look like headers
      if (!line || line.toLowerCase().includes('start_time') || line.toLowerCase().includes('timestamp')) {
        continue;
      }

      try {
        // Parse CSV line - handle potential commas in words
        const parts = this.parseCSVLine(line);
        
        if (parts.length < 3) {
          errors.push(`Line ${i + 1}: Expected 3 parts, got ${parts.length}`);
          continue;
        }

        const [startTime, endTime, word] = parts;
        
        const start = parseFloat(startTime);
        const end = parseFloat(endTime);
        
        if (isNaN(start) || isNaN(end)) {
          errors.push(`Line ${i + 1}: Invalid timestamps`);
          continue;
        }

        if (!word || word.trim().length === 0) {
          errors.push(`Line ${i + 1}: Empty word`);
          continue;
        }

        translatedWords.push({
          word: word.trim(),
          start_time: start,
          end_time: end
        });
      } catch (error) {
        errors.push(`Line ${i + 1}: ${error.message}`);
      }
    }

    // If we have errors but some successful parses, log warnings
    if (errors.length > 0 && translatedWords.length > 0) {
      console.warn(`⚠️ Batch ${batch.id} CSV parsing had ${errors.length} errors but recovered ${translatedWords.length} words`);
    }

    // If no words were parsed successfully, try fallback parsing
    if (translatedWords.length === 0) {
      console.warn(`⚠️ Batch ${batch.id} CSV parsing failed, attempting fallback parsing`);
      return this.fallbackCSVParse(csvContent, batch);
    }

    return translatedWords;
  }

  parseCSVLine(line) {
    // Handle CSV parsing with potential commas in words
    const parts = [];
    let current = '';
    let inQuotes = false;
    let partCount = 0;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current.trim());
        current = '';
        partCount++;
        
        // If we have 2 parts (timestamps), everything else is the word
        if (partCount === 2) {
          parts.push(line.substring(i + 1).trim().replace(/^"|"$/g, ''));
          break;
        }
      } else {
        current += char;
      }
    }
    
    // Add the last part if we haven't reached the word yet
    if (partCount < 2) {
      parts.push(current.trim());
    }
    
    return parts;
  }

  fallbackCSVParse(csvContent, batch) {
    console.warn(`🔄 Using fallback CSV parsing for batch ${batch.id}`);
    
    // Try to extract any English words from the response
    const words = csvContent
      .split(/[\n,\s]+/)
      .filter(word => word.trim().length > 0)
      .filter(word => !/^\d+\.?\d*$/.test(word)) // Remove pure numbers (timestamps)
      .filter(word => /^[a-zA-Z]/.test(word)) // Keep words starting with letters
      .slice(0, batch.words.length * 2); // Limit to reasonable number

    if (words.length === 0) {
      throw new Error('No English words found in LLM response');
    }

    // Distribute timestamps across found words
    const translatedWords = [];
    const totalDuration = batch.words[batch.words.length - 1].end - batch.words[0].start;
    const timePerWord = totalDuration / words.length;

    words.forEach((word, index) => {
      const startTime = batch.words[0].start + (index * timePerWord);
      const endTime = startTime + timePerWord;
      
      translatedWords.push({
        word: word.trim(),
        start_time: startTime,
        end_time: endTime
      });
    });

    console.warn(`⚠️ Fallback parsing extracted ${translatedWords.length} words`);
    return translatedWords;
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
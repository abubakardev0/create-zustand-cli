import { EnhancedTranslationProcessor } from './translation-processor.js';

// Test the CSV parsing functionality
async function testCSVParsing() {
  console.log('🧪 Testing CSV parsing functionality...\n');
  
  const processor = new EnhancedTranslationProcessor({
    languageName: 'Urdu',
    batchSize: 5
  });

  // Mock batch data
  const mockBatch = {
    id: 1,
    words: [
      { text: 'یہ', start: 0.0, end: 0.5 },
      { text: 'ایک', start: 0.5, end: 0.8 },
      { text: 'ٹیسٹ', start: 0.8, end: 1.2 },
      { text: 'ہے', start: 1.2, end: 1.6 }
    ]
  };

  // Test different CSV response formats
  const testCases = [
    {
      name: 'Perfect CSV Response',
      csvResponse: `0.0,0.5,This
0.5,0.8,is
0.8,1.2,a
1.2,1.6,test`
    },
    {
      name: 'CSV with Headers (should be ignored)',
      csvResponse: `start_time,end_time,word
0.0,0.5,This
0.5,0.8,is
0.8,1.2,a
1.2,1.6,test`
    },
    {
      name: 'CSV with Quoted Words',
      csvResponse: `0.0,0.5,"This"
0.5,0.8,"is"
0.8,1.2,"a"
1.2,1.6,"test"`
    },
    {
      name: 'CSV with Commas in Words',
      csvResponse: `0.0,0.5,"Hello, world"
0.5,1.2,this
1.2,1.6,works`
    },
    {
      name: 'Malformed CSV (triggers fallback)',
      csvResponse: `This is a test response that doesn't follow CSV format
but contains English words that should be extracted`
    },
    {
      name: 'Mixed Format (some valid, some invalid)',
      csvResponse: `0.0,0.5,This
invalid line here
0.8,1.2,still
1.2,1.6,works`
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n📝 Testing: ${testCase.name}`);
    console.log(`Input CSV:\n${testCase.csvResponse}\n`);
    
    try {
      const result = processor.parseCSVResponse(testCase.csvResponse, mockBatch);
      console.log(`✅ Parsed ${result.length} words:`);
      result.forEach((word, index) => {
        console.log(`   ${index + 1}. "${word.word}" (${word.start_time}s - ${word.end_time}s)`);
      });
      
      const translatedText = result.map(w => w.word).join(' ');
      console.log(`📝 Final text: "${translatedText}"`);
      
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
    
    console.log('─'.repeat(50));
  }

  // Test the CSV line parsing specifically
  console.log('\n🔍 Testing CSV line parsing edge cases:');
  
  const lineCases = [
    '0.5,1.0,simple',
    '0.5,1.0,"quoted word"',
    '0.5,1.0,"word with, comma"',
    '0.5,1.0,word with spaces at end   ',
    '0.5,1.0,"complex, sentence with multiple, commas"'
  ];
  
  lineCases.forEach(line => {
    console.log(`\nInput: ${line}`);
    const parts = processor.parseCSVLine(line);
    console.log(`Output: [${parts.map(p => `"${p}"`).join(', ')}]`);
  });
}

// Test fallback translation
async function testFallbackTranslation() {
  console.log('\n\n🧪 Testing fallback translation functionality...\n');
  
  const processor = new EnhancedTranslationProcessor({
    languageName: 'Urdu'
  });

  const testWords = [
    'یہ',      // this
    'ایک',     // a/one
    'ہے',      // is
    'اور',     // and
    'میں',     // in
    'کا',      // of
    'ٹیسٹ',    // test (should use phonetic)
    'پروگرام',  // program (should use phonetic)
    'کمپیوٹر'   // computer (should use phonetic)
  ];

  console.log('Testing word-by-word fallback translation:');
  testWords.forEach(word => {
    const translation = processor.getBasicTranslation(word, 'Urdu');
    console.log(`"${word}" → "${translation}"`);
  });

  // Test Spanish words too
  console.log('\nTesting Spanish fallback translation:');
  const spanishWords = ['el', 'la', 'de', 'que', 'y', 'hola', 'gracias'];
  spanishWords.forEach(word => {
    const translation = processor.getBasicTranslation(word, 'Spanish');
    console.log(`"${word}" → "${translation}"`);
  });
}

// Run all tests
async function runAllTests() {
  try {
    await testCSVParsing();
    await testFallbackTranslation();
    console.log('\n🎉 All tests completed!');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

runAllTests();
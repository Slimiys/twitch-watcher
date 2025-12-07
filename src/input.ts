import * as readline from 'readline';
import { LoginInput } from './types';

/**
 * Создание интерфейса readline для интерактивного ввода
 */
function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * Вопрос пользователю с поддержкой вставки текста
 * @param rl Интерфейс readline
 * @param question Текст вопроса
 * @param isPassword Скрывать ли ввод (для паролей)
 * @returns Промис с ответом пользователя
 */
function askQuestion(rl: readline.Interface, question: string, isPassword: boolean = false): Promise<string> {
  return new Promise((resolve) => {
    // Для паролей используем стандартный ввод без маскировки
    // так как в Windows консоли это может мешать вставке
    // Пользователь может вставить текст через Ctrl+V или правой кнопкой мыши
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Функция для интерактивного запроса данных авторизации
 * Поддерживает вставку текста через Ctrl+V в Windows
 * @returns Промис с данными для входа (токен и путь к исполняемому файлу)
 */
export const askLogin = async (): Promise<LoginInput> => {
  const rl = createReadlineInterface();
  
  try {
    console.log('\n📝 Введите данные для авторизации:');
    console.log('💡 Подсказка: Вы можете вставить текст через Ctrl+V (или правой кнопкой мыши)\n');
    
    let token = '';
    let exec = '';
    
    // Запрос токена
    while (!token) {
      token = await askQuestion(rl, 'Enter your auth-token from twitch.tv 🔑: ', true);
      if (!token) {
        console.log('❌ Токен не может быть пустым! Пожалуйста, введите токен.');
      }
    }
    
    // Запрос пути к браузеру с путем по умолчанию для Windows
    const defaultPath = process.platform === 'win32' 
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : '/usr/bin/chromium-browser';
    
    const execPrompt = process.platform === 'win32'
      ? `Enter the browser executable path [${defaultPath}]: `
      : `Enter the chromium executable path (usually /usr/bin/chromium-browser or /usr/bin/chromium) [${defaultPath}]: `;
    
    exec = await askQuestion(rl, execPrompt);
    
    // Если пользователь не ввел путь, используем путь по умолчанию
    if (!exec) {
      exec = defaultPath;
      console.log(`✅ Using default path: ${exec}`);
    }
    
    return { token, exec };
  } finally {
    rl.close();
  }
};


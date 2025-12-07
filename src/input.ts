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
 * @returns Промис с данными для входа (токен)
 */
export const askLogin = async (): Promise<LoginInput> => {
  const rl = createReadlineInterface();
  
  try {
    console.log('\n📝 Введите данные для авторизации:');
    console.log('💡 Подсказка: Вы можете вставить текст через Ctrl+V (или правой кнопкой мыши)\n');
    
    let token = '';
    
    // Запрос токена
    while (!token) {
      token = await askQuestion(rl, 'Enter your auth-token from twitch.tv 🔑: ', true);
      if (!token) {
        console.log('❌ Токен не может быть пустым! Пожалуйста, введите токен.');
      }
    }
    
    return { token };
  } finally {
    rl.close();
  }
};


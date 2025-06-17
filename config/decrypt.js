const crypto = require('crypto');
// Encryption Key from .NET
const base64Key = "rs0mZ46th94XSWjMQolnBR6f23g3QSUSdqXlrlY6ARA=";
const keyBytes = Buffer.from(base64Key, 'base64');
// Decryption function using AES-256-CBC and PKCS7 padding (matching .NET)
function decryptData(cipherText) {
    try {
      // Split IV and CipherText (format: IV:CipherText)
      const parts = cipherText.split(':');
      if (parts.length !== 2) {
        console.error("Invalid encrypted format. Expected IV:CipherText");
        return null;
      }
  
      const ivBytes = Buffer.from(parts[0], 'base64'); // Extract IV (16 bytes)
      const encryptedBytes = Buffer.from(parts[1], 'base64'); // Extract CipherText
  
      const decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, ivBytes);
      let decrypted = decipher.update(encryptedBytes, 'binary', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted.trim();
    } catch (error) {
      console.error('Decryption error:', error);
      return null;
    }
  }

  module.exports = {
    decryptData  
  };
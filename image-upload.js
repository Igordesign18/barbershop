// Upload de imagens com conversao automatica para JPEG.
//
// Por que isso existe: fotos tiradas direto no iPhone/iPad costumam vir no
// formato HEIC/HEIF. O navegador aceita o upload normalmente (o mimetype
// comeca com "image/"), mas quase nenhum navegador fora do Safari consegue
// EXIBIR um arquivo HEIC depois de salvo - por isso a foto "nao aparece"
// para quem usa Android, Windows ou Chrome/Firefox no proprio iPhone.
//
// A solucao e nao confiar no formato que o cliente mandou: todo upload passa
// pelo sharp e e regravado em disco como .jpg, que funciona em qualquer lugar.
// De brinde, tambem corrige a orientacao (fotos de celular vem com rotacao
// via EXIF que alguns navegadores ignoram) e comprime um pouco o arquivo.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');

function makeUpload(destDir, { maxSize = 15 * 1024 * 1024, quality = 85 } = {}) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const base = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSize },
    fileFilter: (req, file, cb) => {
      const looksLikeImage = file.mimetype.startsWith('image/') ||
        /\.(heic|heif)$/i.test(file.originalname || '');
      if (!looksLikeImage) return cb(new Error('Arquivo deve ser uma imagem'));
      cb(null, true);
    }
  });

  async function saveAsJpeg(file) {
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
    const filePath = path.join(destDir, filename);
    // failOn: 'none' faz o sharp tentar ler o arquivo mesmo se o HEIC vier
    // com metadados incomuns, em vez de rejeitar de primeira.
    await sharp(file.buffer, { failOn: 'none' })
      .rotate()
      .jpeg({ quality, mozjpeg: true })
      .toFile(filePath);
    file.filename = filename;
    file.path = filePath;
    return file;
  }

  function single(fieldName) {
    const middleware = base.single(fieldName);
    return (req, res, next) => {
      middleware(req, res, async (err) => {
        if (err) return next(err);
        if (!req.file) return next();
        try {
          await saveAsJpeg(req.file);
          next();
        } catch (e) {
          next(new Error('Nao foi possivel processar a imagem enviada'));
        }
      });
    };
  }

  function fields(fieldsConfig) {
    const middleware = base.fields(fieldsConfig);
    return (req, res, next) => {
      middleware(req, res, async (err) => {
        if (err) return next(err);
        try {
          const allFiles = req.files
            ? Object.values(req.files).flat()
            : [];
          for (const file of allFiles) {
            await saveAsJpeg(file);
          }
          next();
        } catch (e) {
          next(new Error('Nao foi possivel processar a imagem enviada'));
        }
      });
    };
  }

  return { single, fields };
}

module.exports = { makeUpload };

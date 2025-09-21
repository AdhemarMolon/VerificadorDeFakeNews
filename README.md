# Fake Checker


Extensão de navegador e backend para checagem automática de notícias e conteúdos usando IA e busca em fontes confiáveis.


## Visão Geral


O Fake Checker é uma solução completa para verificação de notícias, composta por:


- **Extensão Chrome:** Permite ao usuário checar rapidamente a confiabilidade de qualquer página da web.
- **Backend Node.js:** Usa IA (Gemini (Google AI)) e busca web (Serper/Bing/SerpAPI) para analisar o conteúdo e sugerir fontes confiáveis.


## Como Funciona


1. **Coleta de Conteúdo:** A extensão extrai o texto, título, autor, data e links da página visitada.
2. **Envio ao Backend:** O conteúdo é enviado para a API `/classify`.
3. **Análise por IA:** O backend utiliza IA para:
- Classificar como `fake`, `duvidoso` ou `confiavel`.
- Extrair afirmações checáveis e buscar corroborações em fontes confiáveis.


### Backend


1. Acesse a pasta do backend:
`cd backend`
2. Instale as dependências:
`npm install`
3. Configure as chaves de API no arquivo `.env` (**GEMINI_API_KEY**, e **SERPER_KEY**/**BING_KEY**/**SERPAPI_KEY**).
4. Inicie o servidor:
`npm start`


Depois, use a extensão no Chrome: ative o modo de desenvolvedor em `chrome://extensions` e carregue a pasta da extensão em **Load Unpacked**.
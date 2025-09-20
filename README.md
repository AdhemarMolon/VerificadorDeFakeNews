# Fake Checker

Extensão de navegador e backend para checagem automática de notícias e conteúdos usando IA e busca em fontes confiáveis.

## Visão Geral

O Fake Checker é uma solução completa para verificação de notícias, composta por:

- **Extensão Chrome:** Permite ao usuário checar rapidamente a confiabilidade de qualquer página da web.
- **Backend Node.js:** Usa IA (OpenAI GPT) e busca web (Serper, Bing ou SerpAPI) para analisar o conteúdo e sugerir fontes confiáveis.

## Como Funciona

1. **Coleta de Conteúdo:** A extensão extrai o texto, título, autor, data e links da página visitada.
2. **Envio ao Backend:** O conteúdo é enviado para a API `/classify`.
3. **Análise por IA:** O backend utiliza IA para:
   - Extrair afirmações factuais do texto.
   - Classificar o conteúdo como "fake", "duvidoso" ou "confiável".
   - Buscar fontes confiáveis na web que corroborem ou contradigam as afirmações.
4. **Exibição do Resultado:** A extensão mostra ao usuário a classificação, motivos e links de fontes confiáveis.

## Principais Recursos

- **Classificação automática:** IA analisa o texto e atribui um rótulo de confiabilidade.
- **Busca ativa:** Integração com buscadores para encontrar checagens e notícias relevantes.
- **Filtro de fontes:** Apenas domínios confiáveis são sugeridos como referência.
- **Interface amigável:** Resultados claros e visualmente destacados na extensão.

## Instalação

### Backend

1. Acesse a pasta `backend`:
   cd HackatonRaia/backend

2. Instale as dependências:
    npm install

3. Configure as chaves de API no arquivo .env (OpenAI, Serper, etc).
4. Inicie o servidor:
    npm start

após isso use a extensão no Chrome: ativando a opção de desenvolvedor no chrome://extensions e carrega essa pasta na opção "Load Unpacked"

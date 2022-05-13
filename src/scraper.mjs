import jsdom from 'jsdom';
import axios from 'axios';

const { JSDOM } = jsdom;
const BASE_URL = 'http://floristpages.com/';

export default async function scraper() {
  const page = await getPage(BASE_URL);

  const dom = new JSDOM(page);
  const document = dom.window.document;

  const title = document.querySelector('h1').textContent;

  console.log(title);
}

async function getPage(url) {
  return await axios
    .get(url)
    .then((response) => response.data)
    .catch((response) => response.data);
}

scraper();

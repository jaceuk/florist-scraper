/*
NOTE: ALWAYS throw an exception if there is any missing dog data.
This typically means the website template has changed so the scraping code needs changing.
Throwing an exception prevents existing data from getting deleted whilst this is fixed.
*/

var BreedsModel = require('../models/breeds.model.js');
var LocationsModel = require('../models/locations.model.js');
var DogsModel = require('../models/dogs.model.js');
var ImagesModel = require('../models/images.model.js');
const puppeteer = require('puppeteer');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');
const del = require('del');

const ORGANISATION_NAME = 'RSPCA'; // do not uses spaces!
const ORGANISATION_ID = 2; // This has to match the organisation id in the database
const BASE_URL = 'https://www.rspca.org.uk';
const RESULTS_PAGE_URL = BASE_URL + '/findapet#onSubmitSetHere';
const SCRAPE_DELAY = 0.5 * 1000; // .5 sec
const DB_DELAY = 0.25 * 1000; // .25 sec

exports.scrape = async (useLocalFile, searchPagesLimit) => {
  let data;
  let outPut = {
    dogsAdded: 0,
    dogsUpdated: 0,
    dogsDeleted: 0,
    imagesAdded: 0,
    imagesDeleted: 0,
    newLocations: [],
  };

  if (useLocalFile) {
    // read from file
    data = await JSON.parse(getFromFile(ORGANISATION_NAME));
  } else {
    // use puppeteer to get search results
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    await page.goto(RESULTS_PAGE_URL);

    // populate search for and submit
    await page.waitForSelector('#searchForm');
    await page.$eval('#PSanimalType', (el) => (el.value = 'DOG'));
    await page.$eval('#searchedLocation', (el) => (el.value = 'all'));
    await page.click('#addressSearchGoButton');

    // get search results
    await page.waitForSelector('#petSearchResults');
    const dogPages = await page.evaluate(() => {
      let divs = [...document.querySelectorAll('#petSearchResults li a')];
      return divs.map((div) => div.href);
    });

    await browser.close();

    let dogData = [];

    // iterate through all the individual dog page urls
    for (let i = 0; i < dogPages.length; i++) {
      // delay between each page fetch
      await delay(SCRAPE_DELAY);
      const dogPageHtml = await getPage(dogPages[i]);

      const dom = new JSDOM(dogPageHtml);
      const document = dom.window.document;

      // name
      let name = null;
      const scrapedName = document.querySelector('.animalHeading h1');
      if (scrapedName) {
        name = scrapedName.textContent.trim();
        name = name[0].toUpperCase() + name.slice(1).toLowerCase();
      }

      // sex
      let sex = null;

      // size
      let size = null;

      // location
      let locationName = '';
      let locationId = null;
      const scrapedLocation = document.querySelector('.establishmentLocation > p:nth-child(2)');
      if (scrapedLocation) {
        // check against location name to retrieve id
        locationName = scrapedLocation.textContent.trim();
        locationId = await getLocationId(locationName, ORGANISATION_ID);

        // if there's no location id then save the location name to send by email to be added manually
        if (!locationId) {
          outPut.newLocations.push(locationName);
        }
      }

      // breed
      let breedName = '';
      let breedId = 1;
      const scrapedBreed = document.querySelector(
        '#petDetailsPortlet > div.petOverview > div.additionalInfo > div.aboutMe.schemeBorder.themeFindAPetBorder.desktop > table > tbody > tr:nth-child(1) > td',
      );
      if (scrapedBreed) {
        breedName = scrapedBreed.textContent.trim().replace(/\t/g, '').replace(/\n/g, ' ').replace('  ', ' ');
        breedId = await getBreedId(breedName);
      }

      // age
      let ageGroup = null;
      const scrapedAge = document.querySelector(
        '#petDetailsPortlet > div.petOverview > div.additionalInfo > div.aboutMe.schemeBorder.themeFindAPetBorder.desktop > table > tbody > tr:nth-child(3) > td',
      );
      if (scrapedAge) {
        ageGroup = convertToAgeGroup(scrapedAge.textContent.trim());
      }

      // description
      let description = '';
      const descriptionParagraphs = document.querySelectorAll('.petDescription p');
      if (descriptionParagraphs) {
        descriptionParagraphs.forEach((paragraph) => {
          const paragraphText = paragraph.textContent.trim();
          description += `<p>${paragraph.textContent.trim()}</p>`;
        });
      } else {
        description = null;
      }

      // child friendly
      let children = 'unknown';
      const familyTextContainer = document.querySelector(
        '#lifeStyle img[src="/webContent/staticImages/findapet/lifestyle/family.png"] + span',
      );
      if (familyTextContainer) {
        familyText = familyTextContainer.textContent.trim();
        if (familyText === "I'd prefer an adult only household") {
          children = 'no';
        } else {
          children = 'yes';
        }
      }

      // dog friendly
      let dogs = 'unknown';
      const dogTextContainer = document.querySelector(
        '#lifeStyle img[src="/webContent/staticImages/findapet/lifestyle/dog.png"] + span',
      );
      if (dogTextContainer) {
        dogText = dogTextContainer.textContent.trim();
        if (dogText === "I'd prefer to be the only dog in a home") {
          dogs = 'no';
        } else {
          dogs = 'yes';
        }
      }

      // cat friendly
      let cats = 'unknown';
      const catTextContainer = document.querySelector(
        '#lifeStyle img[src="/webContent/staticImages/findapet/lifestyle/cat.png"] + span',
      );
      if (catTextContainer) {
        catText = catTextContainer.textContent.trim();
        if (catText === "I'd prefer not to live with a cat") {
          cats = 'no';
        } else {
          cats = 'yes';
        }
      }

      // get images
      let images = [];
      const knownPlaceholderImages = ['imageId=295471', 'imageId=A204567', 'imageId=296517'];

      // get images from the carousel
      const smallImages = document.querySelectorAll('.carouselImgHolder img');
      if (smallImages) {
        smallImages.forEach((smallImage) => {
          const smallImageSrc = smallImage.src.replace('https://www.rspca.org.uk', '');
          let isPlaceholder;

          // check against known placeholders and only include genuine images
          for (let i = 0; i < knownPlaceholderImages.length; i++) {
            if (smallImageSrc.includes(knownPlaceholderImages[i])) {
              isPlaceholder = true;
            }
          }

          if (!isPlaceholder) {
            const largeImage = smallImageSrc.replace('size=small', 'size=large');
            images.push({
              isMain: null,
              url: BASE_URL + largeImage,
            });
          }
        });
      }

      // if no carousel then check if there's just a single image
      if (images.length === 0) {
        const singleImage = document.querySelector('#largeImage');
        if (singleImage) {
          const singleImageUrl = singleImage.src.replace('https://www.rspca.org.uk', '');
          let isPlaceholder;

          // check against known placeholders and only include genuine images
          for (let i = 0; i < knownPlaceholderImages.length; i++) {
            if (singleImageUrl.includes(knownPlaceholderImages[i])) {
              isPlaceholder = true;
            }
          }

          if (!isPlaceholder) {
            images.push({
              isMain: null,
              url: BASE_URL + singleImage.src,
            });
          }
        }
      }

      // set first image in list to main
      if (images[0]) images[0].isMain = 1;

      // youtube video
      let youtube = null;
      const videoIframe = document.querySelector('#largeVid');
      if (videoIframe) {
        const youtubeURL = videoIframe.src;
        youtube = youtubeURL.replace('//www.youtube.com/embed/', '').split('?')[0];
        if (youtube === '') youtube = null;
      }

      // only push data if there is a name and locationId
      if (name && locationId) {
        dogData.push({
          source: dogPages[i],
          name: name,
          sex: sex,
          ageGroup: ageGroup,
          size: size,
          breedId: breedId,
          breedName: breedName,
          locationId: locationId,
          locationName: locationName,
          children: children,
          dogs: dogs,
          cats: cats,
          description: description,
          youtube: youtube,
          images: images,
        });
      } else {
        console.log(`${name} not added. Loctation: ${locationName}. URL: ${dogPages[i]}`);
      }
    }

    data = {
      organisationName: ORGANISATION_NAME,
      baseURL: BASE_URL,
      resultsPageURL: RESULTS_PAGE_URL,
      dogData: dogData,
    };

    // save to file
    const contents = JSON.stringify(data);
    const path = __dirname + '/data/' + ORGANISATION_NAME + '.json';
    fs.writeFile(path, contents, function (err) {
      if (err) return console.log(err);
    });
  }

  // process the data
  const dogData = data.dogData;

  // abort if no dogs in import
  if (!dogData) return outPut;

  // delete dogs from the database that are no longer in the import
  // along with images (from the database and folder itself)
  const dogsDeleted = await deleteOldDogs(ORGANISATION_ID, dogData);
  if (dogsDeleted) outPut.dogsDeleted = dogsDeleted;

  // update the database with all dogs in the new import
  await Promise.all(
    dogData.map(async (dog) => {
      let dogId = await getDogId(dog.source);
      if (dogId) {
        // if dog already exists update existing record
        const result = await updateDog(dogId, dog);
        if (!result) throw new Error('There was a problem updating an existing dog.');
        outPut.dogsUpdated++;
      } else {
        // if dog doesn't exist create a new record
        const result = await addDog(dog);
        if (!result) throw new Error('There was a problem creating a new dog.');
        dogId = result;
        outPut.dogsAdded++;
      }

      createImagesFolder(dogId);

      // delete old images from the database and the matching files
      const imagesDeleted = await deleteOldImages(dogId, dog, ORGANISATION_ID, dog.name);
      if (imagesDeleted) outPut.imagesDeleted = imagesDeleted;

      // update images table
      const images = dog.images;

      let mainImageSource;
      for (let i = 0; i < images.length; i++) {
        // get source of main image
        if (images[i].isMain) mainImageSource = images[i].url;

        const filename = images[i].url.split('imageId=')[1] + '.jpg';

        // Does image exist in database?
        const image = await ImagesModel.getByKey('source', images[i].url);

        let addImage;
        const sourceURL = images[i].url;

        if (!image) {
          addImage = true;
        } else {
          // check that the image has the correct dogId
          if (image.dog != dogId) {
            // delete the image from the db if it doesn't
            await ImagesModel.delete(image.id);
            addImage = true;
          }
          // check image exists in file system???????
          const dir = 'public/uploads/org' + ORGANISATION_ID + '/dog' + dogId + '/' + filename;
          if (!fs.existsSync(dir)) {
            // upload the missing image
            await importImage(filename, dogId, ORGANISATION_ID, sourceURL);
          }
        }

        // add new image to the database and import the file
        if (addImage) {
          await importImage(filename, dogId, ORGANISATION_ID, sourceURL);
          await addImageToDb(filename, dogId, sourceURL);
          // delay between each image fetch
          await delay(SCRAPE_DELAY);
          outPut.imagesAdded++;
        }
      }
      // set main image
      if (images.length) await ImagesModel.setMain(mainImageSource);
    }),
  );

  // output results
  console.log(outPut);
  return outPut;
};

// Supporting functions

// delay for page request so as to not overload site being scraped
const delay = (interval) => new Promise((resolve) => setTimeout(resolve, interval));

async function getPage(url) {
  return axios
    .get(url)
    .then((response) => response.data)
    .catch((response) => response.data);
}

function getFromFile(organisationName) {
  const path = __dirname + '/data/' + organisationName + '.json';
  return fs.readFileSync(path);
}

function convertToAgeGroup(age) {
  if (age === '3-6 Months') {
    return 'puppy';
  }
  if (age === '6-12 Months' || age === '1 Year (approx)' || age === '2 Years (approx)') {
    return 'juvenile';
  }
  return 'adult';
}

async function getBreedId(breedName) {
  const breedData = await BreedsModel.getByKey('name', breedName);
  // default to breed not specified/unknown
  if (!breedData) return 1;
  return breedData.id;
}

async function getLocationId(locationName, organisationId) {
  const locationData = await LocationsModel.getMultipleByKey('name', locationName);
  let locationId;
  if (locationData) {
    locationData.forEach((location) => {
      if (location.organisation === organisationId) locationId = location.id;
    });
  }
  return locationId;
}

async function getDogId(source) {
  const data = await DogsModel.getByKey('source', source);
  if (!data) return;
  return data.id;
}

function createImagesFolder(dogId) {
  // create images folder if one doesn't exist
  const dir = 'public/uploads/org' + ORGANISATION_ID + '/dog' + dogId;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return true;
}

async function deleteOldDogs(organisationId, dogData) {
  // get current dogs
  const dogs = await DogsModel.getByOrganisationId(organisationId);
  const currentDogs = [];
  const newDogs = [];

  // build array of current dogs
  dogs.forEach(async (dog) => {
    // any dog entered through the admin area has no source so shouldn't be changed due to scraping
    if (dog.source) currentDogs.push(dog.source);
  });

  // build array of new dogs
  dogData.forEach(async (data) => {
    newDogs.push(data.source);
  });

  // subtract arrays
  const oldDogs = currentDogs.filter((n) => !newDogs.includes(n));

  // delete dogs no longer in import
  oldDogs.forEach(async (oldDog) => {
    const dog = await DogsModel.getByKey('source', oldDog);
    // delete images from database
    await ImagesModel.deleteByKey('dog', dog.id);
    // remove image folder
    const dir = 'public/uploads/org' + organisationId + '/dog' + dog.id;
    (async () => {
      try {
        await del(dir);
      } catch (err) {
        console.error(`Error while deleting ${dir}.`);
      }
    })();
    await DogsModel.delete(dog.id);
  });

  return oldDogs.length;
}

async function updateDog(dogId, dog) {
  // dont send breed name if there's a breed id
  if (dog.breedId != 1) dog.breedName = null;
  const result = await DogsModel.update(
    (id = dogId),
    (name = dog.name),
    (breed = dog.breedId),
    (size = dog.size),
    (sex = dog.sex),
    (tagline = null),
    (location = dog.locationId),
    (updated_at = new Date()),
    (updated_by = 0),
    (description = dog.description),
    (children = dog.children),
    (dogs = dog.dogs),
    (cats = dog.cats),
    (agegroup = dog.ageGroup),
    (age = null),
    (youtube = dog.youtube),
    (breedname = dog.breedName),
  );
  return result;
}

async function addDog(dog) {
  // don't send breed name if there's a breed id
  if (dog.breedId != 1) dog.breedName = null;
  const result = await DogsModel.create(
    (name = dog.name),
    (breed = dog.breedId),
    (size = dog.size),
    (sex = dog.sex),
    (tagline = null),
    (location = dog.locationId),
    (created_at = new Date()),
    (created_by = 0),
    (description = dog.description),
    (children = dog.children),
    (dogs = dog.dogs),
    (cats = dog.cats),
    (agegroup = dog.ageGroup),
    (age = null),
    (youtube = dog.youtube),
    (source = dog.source),
    (breedname = dog.breedName),
  );
  return result;
}

async function deleteOldImages(dogId, dog, organisationId) {
  // get current images
  const images = await ImagesModel.getAll(dogId);
  const currentImageSources = [];
  const newImageSources = [];

  // build array of current images
  images.forEach(async (image) => {
    currentImageSources.push(image.source);
  });

  // build array of new images
  dog.images.forEach(async (image) => {
    newImageSources.push(image.url);
  });

  // subtract arrays
  const oldImageSources = currentImageSources.filter((n) => !newImageSources.includes(n));

  // delete images no longer in import
  oldImageSources.forEach(async (oldImageSource) => {
    const imageData = await ImagesModel.getByKey('source', oldImageSource);
    if (!imageData) return;
    // delete files
    await deleteOldFile(imageData.id, organisationId, dogId);
    // remove from Database
    await ImagesModel.delete(imageData.id);
  });

  return oldImageSources.length;
}

async function deleteOldFile(imageId, organisationId, dogId) {
  const folder = `public/uploads/org${organisationId}/dog${dogId}/`;
  const filePath = folder + imageId;

  const imageArray = [
    filePath + '.jpg',
    filePath + '-opt.jpg',
    filePath + '-200.jpg',
    filePath + '-400.jpg',
    filePath + '-600.jpg',
    filePath + '-800.jpg',
  ];

  imageArray.forEach((image) => {
    fs.unlink(image, function (err) {
      if (err && err.code == 'ENOENT') {
        // file doesn't exist
        console.info("The image doesn't exist.");
      } else if (err) {
        // other errors, e.g. maybe we don't have enough permission
        console.error('Error occurred while trying to remove file');
      }
    });
  });
}

async function importImage(origFilename, dogId, organisationId, imageUrl) {
  // get file extension
  const fileArray = origFilename.split('.');
  const fileNameLessExt = fileArray[0];
  const ext = fileArray[1];

  const oldPath = `temp/${origFilename}`;
  const newFolder = `public/uploads/org${organisationId}/dog${dogId}/`;
  const newPath = newFolder + fileNameLessExt + '.' + ext;

  try {
    const response = await axios({
      method: 'GET',
      url: imageUrl,
      responseType: 'stream',
    });

    const w = response.data.pipe(fs.createWriteStream(oldPath));
    w.on('finish', () => {
      // image uploaded, proceed with optimising
      fs.rename(oldPath, newPath, (err) => {
        if (err) throw new Error(err);

        // Create optimised image
        sharp(newPath)
          .toFormat('jpeg')
          .jpeg({ quality: 75, force: true })
          .toFile(newFolder + fileNameLessExt + '-opt.jpg', (err, info) => {
            if (err) {
              console.log(err);
            }
          });

        // Create resized versions
        const sizes = [200, 400, 600, 800];

        for (var i = 0; i < sizes.length; i++) {
          sharp(newPath)
            .toFormat('jpeg')
            .jpeg({ quality: 75, force: true })
            .resize(sizes[i])
            .toFile(newFolder + fileNameLessExt + '-' + sizes[i] + '.jpg', (err, info) => {
              if (err) {
                console.log(err);
              }
            });
        }
      });
    });
  } catch (err) {
    throw new Error(err);
  }
  return true;
}

async function addImageToDb(origFilename, dogId, imageUrl) {
  try {
    const isMain = null;
    const updatedAt = new Date();
    const updatedBy = 0;
    await delay(DB_DELAY); // stagger update to prevent connection timeout
    await ImagesModel.create(origFilename, isMain, dogId, updatedAt, updatedBy, imageUrl);
  } catch (err) {
    throw new Error(err);
  }
  return true;
}

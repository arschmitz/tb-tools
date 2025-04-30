import chalk from "chalk";
const endpoint = "https://official-joke-api.appspot.com/jokes/programming/random";

export async function getJoke() {
  const response = await fetch(endpoint);
  const data = await response.json();
  const { promise, resolve } = Promise.withResolvers();

  console.info("", chalk.magenta(data[0].setup));

  setTimeout(() => {
    console.info("", chalk.cyan(data[0].punchline));
    resolve();
  }, 5000);

  await promise;
}

export async function displayJokes(promise, interval = 5 * 60 * 1000) {
  await getJoke();
  const jokeInterval = setInterval(getJoke, interval);

  promise.then(() => clearInterval(jokeInterval));

  await promise;
}